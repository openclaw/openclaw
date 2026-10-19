import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const fixture = vi.hoisted(() => ({
  root: "",
  selectedRoot: "",
  buildId: "2026.9.1-runtime-b",
  build: vi.fn(),
}));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: async () => fixture.root,
  resolveOpenClawPackageRootSync: () => fixture.root,
}));
vi.mock("../infra/control-ui-assets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/control-ui-assets.js")>()),
  resolveControlUiRootSync: () => fixture.selectedRoot,
}));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: fixture.build }));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  resolveRuntimeServiceBuildId: () => fixture.buildId,
}));

import { handleControlUiHttpRequest } from "./control-ui.js";
import {
  createGatewayControlUiRootLifecycle,
  type ControlUiRootState,
} from "./server-control-ui-root.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const buildResult = { code: 0, termination: "exit" };
const assetId = (buildId: string) => `${buildId}-${"a".repeat(64)}`;
const at = (...parts: string[]) => path.join(fixture.root, ...parts);
const macRoot = () => at("OpenClaw.app", "Contents", "Resources", "control-ui");

async function requestIndex(root: ControlUiRootState) {
  const response = makeMockHttpResponse();
  await handleControlUiHttpRequest(
    { url: "/", method: "GET", headers: { host: "gateway.example.test" } } as IncomingMessage,
    response.res,
    { root },
  );
  return response;
}

async function writeUi(root: string, buildId: string) {
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "assets/startup.js"), "export {};");
  await fs.writeFile(
    path.join(root, "index.html"),
    `<html data-openclaw-control-ui-build-id="${assetId(buildId)}"><script src="./assets/startup.js"></script></html>`,
  );
}

function createLifecycle(override?: string) {
  const warn = vi.fn();
  const lifecycle = createGatewayControlUiRootLifecycle({
    controlUiRootOverride: override,
    controlUiEnabled: true,
    gatewayRuntime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    log: { warn },
  });
  return { lifecycle, warn };
}

beforeEach(async () => {
  fixture.buildId = "2026.9.1-runtime-b";
  fixture.root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-identity-")),
  );
  fixture.selectedRoot = at("dist", "control-ui");
  vi.stubEnv("OPENCLAW_STATE_DIR", at("state"));
  await fs.mkdir(at("ui"));
  await fs.mkdir(at("scripts"));
  await fs.writeFile(at("ui", "vite.config.ts"), "export {};");
  await fs.writeFile(at("scripts", "ui.js"), "");
  await writeUi(fixture.selectedRoot, "2026.9.1-runtime-a");
  fixture.build.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(fixture.root, { recursive: true, force: true });
});

test("prepares a complete stale source UI before publishing its shared root", async () => {
  const { selectedRoot, buildId } = fixture;
  const provenancePath = at("dist", "build-info.json");
  const provenance = JSON.stringify({ buildId });
  await fs.writeFile(provenancePath, provenance);
  const build = createDeferred<typeof buildResult>();
  fixture.build.mockReturnValueOnce(build.promise);
  const { lifecycle, warn } = createLifecycle();
  const rootReference = lifecycle.state;
  expect(rootReference).toEqual({ kind: "preparing" });
  const unavailable = await requestIndex(rootReference);
  expect(unavailable.res.statusCode).toBe(503);
  expect(unavailable.setHeader).toHaveBeenCalledWith("Retry-After", "1");

  const preparing = lifecycle.start();
  expect(lifecycle.start()).toBe(preparing);
  await vi.waitFor(() => expect(fixture.build).toHaveBeenCalledOnce());
  expect(rootReference).toEqual({ kind: "preparing" });
  fixture.selectedRoot = at("other", "control-ui");
  fixture.buildId = "2026.9.1-runtime-c";
  await writeUi(fixture.selectedRoot, fixture.buildId);
  await writeUi(selectedRoot, buildId);
  build.resolve(buildResult);
  await preparing;

  expect(lifecycle.state).toBe(rootReference);
  expect(rootReference).toMatchObject({
    kind: "bundled",
    path: selectedRoot,
    publicAssetBuildId: assetId(buildId),
  });
  const ready = await requestIndex(rootReference);
  expect(ready.res.statusCode).toBe(200);
  expect(String(ready.end.mock.calls[0]?.[0])).toContain(assetId(buildId));
  await lifecycle.start();
  await lifecycle.stop();
  expect(fixture.build).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
  expect(await fs.readFile(provenancePath, "utf8")).toBe(provenance);
});

test.each([
  ["matching", undefined, "source", "bundled"],
  ["dev", "dev", "source", "bundled"],
  ["configured", "custom-build", "configured", "resolved"],
  ["macOS", undefined, "mac", "resolved"],
  ["unchanged", "2026.9.1-runtime-a", "source", "failed"],
  ["stale", "2026.9.1-runtime-a", "mac", "failed"],
  ["incomplete", "2026.9.1-runtime-a", "mac", "failed"],
] as const)(
  "prepares the %s root without substituting another identity",
  async (kind, buildId, location, expected) => {
    const failed = expected === "failed";
    const brokenMac = failed && location === "mac";
    if (brokenMac) {
      await writeUi(fixture.selectedRoot, fixture.buildId);
    }
    if (location === "mac") {
      fixture.selectedRoot = macRoot();
    }
    await writeUi(fixture.selectedRoot, buildId ?? fixture.buildId);
    if (kind === "incomplete") {
      await fs.unlink(path.join(fixture.selectedRoot, "assets", "startup.js"));
    }
    if (kind === "unchanged") {
      fixture.build.mockResolvedValueOnce(buildResult);
    }
    const { lifecycle, warn } = createLifecycle(
      location === "configured" ? fixture.selectedRoot : undefined,
    );
    expect(lifecycle.state).toMatchObject({
      kind: failed ? "preparing" : expected,
      ...(!failed && { path: fixture.selectedRoot }),
    });
    await lifecycle.start();
    await lifecycle.stop();
    expect(fixture.build).toHaveBeenCalledTimes(kind === "unchanged" ? 1 : 0);
    if (failed) {
      expect(lifecycle.state).toEqual({ kind: "failed" });
      for (const message of brokenMac
        ? [fixture.selectedRoot, "Reinstall OpenClaw"]
        : ["expected 2026.9.1-runtime-b"]) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(message));
      }
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  },
);
