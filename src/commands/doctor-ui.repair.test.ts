import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CONTROL_UI_BUILD_ID_ATTRIBUTE } from "../gateway/control-ui-root-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { MACOS_APP_INSTALL_OWNER_MARKER } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  root: "",
  buildId: "doctor-runtime-build",
  ensureControlUiAssetsBuilt: vi.fn(),
  note: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => mocks.root),
  resolveOpenClawPackageRootSync: vi.fn(() => mocks.root),
}));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.runCommandWithTimeout }));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  resolveRuntimeServiceBuildId: () => mocks.buildId,
}));
vi.mock("../infra/control-ui-assets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/control-ui-assets.js")>()),
  ensureControlUiAssetsBuilt: mocks.ensureControlUiAssetsBuilt,
}));

import { maybeRepairUiProtocolFreshness } from "./doctor-ui.js";

const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
let prompter: DoctorPrompter;

async function writeIndex(html: string) {
  const index = path.join(mocks.root, "dist/control-ui/index.html");
  await fs.mkdir(path.dirname(index), { recursive: true });
  await fs.writeFile(index, html);
  return index;
}

beforeEach(async () => {
  vi.clearAllMocks();
  prompter = {
    confirmAutoFix: vi.fn(async () => true),
    confirmAggressiveAutoFix: vi.fn(async () => true),
  } as unknown as DoctorPrompter;
  mocks.root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-ui-repair-")),
  );
  await fs.mkdir(path.join(mocks.root, "ui"), { recursive: true });
  await fs.writeFile(path.join(mocks.root, "ui", "package.json"), "{}");
  mocks.ensureControlUiAssetsBuilt.mockImplementation(async (_runtime, opts) => {
    opts.onBuildStart?.();
    return { ok: true };
  });
  mocks.runCommandWithTimeout.mockResolvedValue(
    createCommandResult({ stdout: "abc123 protocol schema changed\n" }),
  );
});

afterEach(async () => {
  await fs.rm(mocks.root, { recursive: true, force: true });
});

it("routes missing app-owned assets to the host without package or git commands", async () => {
  await fs.writeFile(
    path.join(mocks.root, "openclaw-install-owner.json"),
    MACOS_APP_INSTALL_OWNER_MARKER,
  );
  await maybeRepairUiProtocolFreshness(runtime, prompter);

  expect(mocks.note).toHaveBeenCalledWith(
    expect.stringContaining("Managed by OpenClaw.app. Update OpenClaw.app to update this Gateway."),
    "UI",
  );
  for (const fn of [
    prompter.confirmAutoFix,
    prompter.confirmAggressiveAutoFix,
    mocks.ensureControlUiAssetsBuilt,
    mocks.runCommandWithTimeout,
  ]) {
    expect(fn).not.toHaveBeenCalled();
  }
});

it.each([false, true])("repairs source assets (protocol changed=%s)", async (force) => {
  await writeIndex(
    force
      ? `<html ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="${mocks.buildId}-${"a".repeat(64)}"></html>`
      : '<script src="./assets/startup.js"></script>',
  );
  await maybeRepairUiProtocolFreshness(runtime, prompter);
  expect(prompter[force ? "confirmAggressiveAutoFix" : "confirmAutoFix"]).toHaveBeenCalledOnce();
  expect(mocks.ensureControlUiAssetsBuilt).toHaveBeenCalledWith(runtime, {
    root: mocks.root,
    expectedBuildId: mocks.buildId,
    force,
    onBuildStart: expect.any(Function),
  });
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(force ? 1 : 0);
  if (force) {
    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith("UI rebuild complete.", "UI");
    expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining("ui:build"), "UI Freshness");
  }
});

it.each(["incomplete", "markerless", "dev-build"])(
  "checks packaged UI identity without rebuilding it: %s",
  async (failure) => {
    const buildId = failure === "dev-build" ? "dev" : null;
    const marker = buildId
      ? ` ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="${buildId}-${"a".repeat(64)}"`
      : "";
    const html = `<html${marker}><script src="./assets/startup.js"></script></html>`;
    const indexPath = await writeIndex(html);
    if (failure !== "incomplete") {
      await fs.mkdir(path.join(path.dirname(indexPath), "assets"));
      await fs.writeFile(path.join(path.dirname(indexPath), "assets/startup.js"), "// startup");
    }
    await fs.rm(path.join(mocks.root, "ui", "package.json"));

    await maybeRepairUiProtocolFreshness(runtime, prompter);

    if (failure === "dev-build") {
      expect(mocks.note).not.toHaveBeenCalled();
    } else {
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("Reinstall OpenClaw to restore bundled Control UI assets."),
        expect.any(String),
      );
    }
    expect(mocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(await fs.readFile(indexPath, "utf8")).toBe(html);
  },
);

it("reports owner-normalized build failures instead of claiming repair success", async () => {
  mocks.ensureControlUiAssetsBuilt.mockResolvedValueOnce({
    ok: false,
    message: "Control UI build failed: spawn ENOENT",
  });

  await maybeRepairUiProtocolFreshness(runtime, prompter);

  expect(mocks.note).toHaveBeenCalledWith("Control UI build failed: spawn ENOENT", "UI");
  expect(mocks.note).not.toHaveBeenCalledWith("UI build complete.", "UI");
});
