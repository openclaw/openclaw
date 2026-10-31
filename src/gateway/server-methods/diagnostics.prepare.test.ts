import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectTriageDoctorFindings } from "../../commands/triage-doctor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { profileRequest } from "./diagnostics.test-support.js";

// The external Doctor process is covered separately; this suite exercises real preparation and export.
vi.mock("../../commands/triage-doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/triage-doctor.js")>()),
  collectTriageDoctorFindings: vi.fn(),
}));

let stateDir: string;
const config: OpenClawConfig = { tools: { exec: { host: "gateway" } } };

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-diagnostic-prepare-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  fs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({ gateway: { auth: { mode: "token", token: "synthetic-diagnostic-secret" } } }),
  );
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.mocked(collectTriageDoctorFindings).mockResolvedValue([]);
});

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

it("denies read-only operators before collecting diagnostics", async () => {
  const request = profileRequest({ method: "diagnostics.prepare", scopes: ["operator.read"] });
  await request.pending;
  expect(request.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );
  expect(collectTriageDoctorFindings).not.toHaveBeenCalled();
});

it("prepares bounded, sanitized context for this Gateway installation", async () => {
  vi.mocked(collectTriageDoctorFindings).mockResolvedValue([
    { checkId: "test/diagnostic", severity: "warning", message: "observed failure ".repeat(4_000) },
  ]);
  const request = profileRequest({ method: "diagnostics.prepare", config });
  await request.pending;
  expect(request.respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      agentId: "main",
      cwd: expect.any(String),
      context: expect.any(String),
    }),
    undefined,
  );
  const result = request.respond.mock.calls[0]?.[1];
  expect(fs.existsSync(path.join(result.cwd, "openclaw.mjs"))).toBe(true);
  expect(result.context).toContain(`Installation: ${result.cwd}`);
  expect(result.context).toContain(`State: ${stateDir}`);
  expect(result.context).toContain("test/diagnostic");
  expect(result.context).not.toContain("synthetic-diagnostic-secret");
  expect(result.context.length).toBeLessThanOrEqual(32_000);
  expect(fs.existsSync(path.join(stateDir, "logs", "support"))).toBe(false);
});

it.each<OpenClawConfig>([
  { tools: { exec: { host: "node" } } },
  { agents: { defaults: { sandbox: { mode: "all" } } } },
  { cloudWorkers: { requiredProfile: "diagnostic-worker" } },
])("rejects incompatible placement before launching Doctor: %j", async (incompatible) => {
  const request = profileRequest({ method: "diagnostics.prepare", config: incompatible });
  await request.pending;
  expect(request.respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "UNAVAILABLE" }),
  );
  expect(collectTriageDoctorFindings).not.toHaveBeenCalled();
});

it.each(["revoked", "aborted"])("withholds diagnostics when the request is %s", async (reason) => {
  let current = true;
  const controller = new AbortController();
  vi.mocked(collectTriageDoctorFindings).mockImplementation(async () => {
    if (reason === "revoked") {
      current = false;
    } else {
      controller.abort();
    }
    return [];
  });
  const request = profileRequest({
    method: "diagnostics.prepare",
    config,
    hasAuthority: () => current,
    signal: controller.signal,
  });
  await request.pending;
  expect(collectTriageDoctorFindings).toHaveBeenCalledOnce();
  expect(request.respond).not.toHaveBeenCalled();
});
