import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as packageRoot from "../../infra/openclaw-root.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { triageGatewayStartupFailure } from "./startup-triage.js";

afterEach(() => {
  vi.doUnmock("../../commands/triage-failure.js");
  vi.restoreAllMocks();
});

it("leaves startup failure handling intact when an update removed the recovery module", async () => {
  vi.doMock("../../commands/triage-failure.js", () => {
    throw new Error("Recovery module removed by an in-place update");
  });
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  await expect(
    triageGatewayStartupFailure(runtime, new Error("configured plugin crashed during startup")),
  ).resolves.toBeUndefined();
  expect(runtime.error).toHaveBeenCalledWith(
    expect.stringContaining("Triage diagnostics could not load:"),
  );
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw triage"));
  expect(runtime.exit).not.toHaveBeenCalled();
});

it.each(["completed", "failed", undefined, "rejected"] as const)(
  "preserves %s triage outcomes",
  async (outcome) => {
    const failure = new Error("triage command failed");
    vi.doMock("../../commands/triage-failure.js", () => ({
      triageAfterFailure: async () => {
        if (outcome === "rejected") {
          throw failure;
        }
        return outcome;
      },
    }));
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const result = triageGatewayStartupFailure(runtime, new Error("startup failed"));
    if (outcome === "rejected") {
      await expect(result).rejects.toBe(failure);
    } else {
      await expect(result).resolves.toBe(outcome);
    }
    expect(runtime.error).not.toHaveBeenCalled();
  },
);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it("saves startup diagnostics and an opt-in command without admitting a repair agent", async () => {
  const root = await fs.realpath(tempDirs.make("gateway-startup-diagnostics-"));
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "dist", "index.js"),
    `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (process.connected || !args.includes("--non-interactive")) throw new Error("Repair agent admission was allowed");
    const input = args[args.indexOf("--update-result") + 1];
    fs.writeFileSync(${JSON.stringify(path.join(root, "receipt.json"))}, JSON.stringify({ args, failure: JSON.parse(fs.readFileSync(input, "utf8")) }));
  `,
  );
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
    },
    async () => {
      await triageGatewayStartupFailure(
        runtime,
        new Error("configured plugin crashed during startup"),
      );
    },
  );
  const receipt = JSON.parse(await fs.readFile(path.join(root, "receipt.json"), "utf8"));
  expect(receipt.args).toEqual([
    "triage",
    "--update-result",
    expect.any(String),
    "--non-interactive",
  ]);
  expect(receipt.failure.error).toContain("configured plugin crashed during startup");
  const output = runtime.error.mock.calls.flat().join("\n");
  expect(output).toContain("openclaw triage --run --update-result");
  expect(output).toContain("Triage diagnostics saved; no repair agent was started.");
  expect(runtime.exit).not.toHaveBeenCalled();
});
