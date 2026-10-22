import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  callGateway,
  createDoctorRuntime,
  ensureAuthProfileStore,
  mockDoctorConfigSnapshot,
  transformConfigFile,
} from "./doctor.e2e-harness.js";
import { terminalNoteMock } from "./doctor.note-test-helpers.js";
import "./doctor.fast-path-mocks.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

function execRef(id: string) {
  return { source: "exec" as const, provider: "default", id };
}

const execHealthMessage =
  "Gateway health checks skipped because gateway credentials use an exec SecretRef.";

async function expectExecGatewayProbe(
  gateway: NonNullable<OpenClawConfig["gateway"]>,
  skipped: boolean,
  env: Record<string, string> = {},
): Promise<void> {
  mockDoctorConfigSnapshot({
    config: {
      gateway,
      secrets: { providers: { default: { source: "exec", command: process.execPath } } },
    },
  });
  callGateway.mockClear();
  await withEnvAsync(env, runDoctorNonInteractive);
  if (skipped) {
    expect(callGateway).not.toHaveBeenCalled();
    expectNote("Gateway", execHealthMessage);
  } else {
    expect(
      terminalNoteMock.mock.calls.some(
        ([message, title]) => title === "Gateway" && String(message).includes(execHealthMessage),
      ),
    ).toBe(false);
  }
}

async function runDoctorNonInteractive(): Promise<void> {
  await doctorCommand(createDoctorRuntime(), {
    nonInteractive: true,
    workspaceSuggestions: false,
  });
}

function expectNote(title: string, ...messages: string[]) {
  expect(
    terminalNoteMock.mock.calls.some(
      ([text, noteTitle]) =>
        noteTitle === title && messages.every((message) => String(text).includes(message)),
    ),
  ).toBe(true);
}

beforeAll(async () => {
  vi.doUnmock("../flows/doctor-health-contributions.js");
  vi.doUnmock("./doctor-state-integrity.js");
  ({ doctorCommand } = await import("./doctor.js"));
});

beforeEach(() => {
  terminalNoteMock.mockClear();
});

it("reports when the state directory was missing at doctor start", async () => {
  mockDoctorConfigSnapshot();

  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-missing-state-"));
  fs.rmSync(missingDir, { recursive: true, force: true });
  await withEnvAsync({ OPENCLAW_STATE_DIR: missingDir }, async () => {
    await runDoctorNonInteractive();
  });

  expectNote("State integrity", "State directory was missing at doctor start");
});

it("warns about active OpenCode provider overrides", async () => {
  const provider = (suffix: string) => ({
    api: "openai-completions" as const,
    baseUrl: `https://opencode.ai/zen/${suffix}`,
  });
  mockDoctorConfigSnapshot({
    config: {
      models: {
        providers: {
          opencode: provider("v1"),
          "opencode-go": provider("go/v1"),
        },
      },
    },
  });

  await runDoctorNonInteractive();

  expectNote("OpenCode", "models.providers.opencode", "models.providers.opencode-go");
});

it.each([
  ["custom OpenAI proxy", { api: "openai-responses", baseUrl: "https://custom.example.com" }],
  [
    "header-only",
    {
      baseUrl: "https://custom.example.com",
      headers: { "X-Custom-Auth": "token-123" },
      models: [{ id: "gpt-5.4" }],
    },
  ],
] as const)("does not warn for %s overrides", async (_label, provider) => {
  mockDoctorConfigSnapshot({
    config: {
      models: { providers: { "openai-codex": provider } },
      auth: {
        profiles: {
          "openai:user@example.com": {
            provider: "openai",
            mode: "oauth",
            email: "user@example.com",
          },
        },
      },
    },
  });
  ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  await runDoctorNonInteractive();
  expect(terminalNoteMock.mock.calls.some(([, title]) => title === "Codex OAuth")).toBe(false);
});

it("keeps doctor read-only when gateway token is SecretRef-managed but unresolved", async () => {
  mockDoctorConfigSnapshot({
    config: {
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
          token: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_GATEWAY_TOKEN",
          },
        },
      },
      secrets: { providers: { default: { source: "env" } } },
    },
  });

  await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, runDoctorNonInteractive);

  expectNote(
    "Gateway auth",
    "Gateway token SecretRef could not be resolved: gateway.auth.token SecretRef is unresolved",
  );
  expectNote(
    "Gateway auth",
    "Doctor will not overwrite gateway.auth.token with a plaintext value.",
  );
  expect(transformConfigFile).not.toHaveBeenCalled();
});

const token = execRef("gateway/token");
const password = execRef("gateway/password");
const remoteToken = execRef("gateway/remote-token");
const remotePassword = execRef("gateway/remote-password");
const envToken = { OPENCLAW_GATEWAY_TOKEN: "fallback-token" };
const envPassword = { OPENCLAW_GATEWAY_PASSWORD: "fallback-password" };
type Gateway = NonNullable<OpenClawConfig["gateway"]>;
const local = (auth: Gateway["auth"]): Gateway => ({ mode: "local", auth });
const remote = (credentials: Gateway["remote"], auth?: Gateway["auth"]): Gateway => ({
  mode: "remote",
  remote: { url: "https://gateway.example.test", ...credentials },
  auth,
});

it.each([
  ["token / env password", local({ mode: "token", token }), true, envPassword],
  ["ambiguous exec refs", local({ token, password }), true, {}],
  ["remote token / env token", remote({ token: remoteToken }), true, envToken],
  ["remote / local exec fallback", remote({}, { mode: "password", token }), true, {}],
  ["dormant token", local({ mode: "password", password: "configured-password", token }), false, {}],
  ["env token / exec password", local({ password }), false, envToken],
  ["password / env password", local({ mode: "password", password }), true, envPassword],
  [
    "remote password / env token",
    remote({ password: remotePassword }, { mode: "password" }),
    false,
    envToken,
  ],
  [
    "remote token / env password",
    remote({ token: remoteToken }, { mode: "token" }),
    false,
    envPassword,
  ],
  [
    "local auth with dormant remote exec refs",
    {
      mode: "local",
      auth: { mode: "token", token: "configured-token" },
      remote: remote({ token: remoteToken }).remote,
    },
    false,
    {},
  ],
] as const)("gateway probe selection: %s", async (_label, gateway, skipped, env) => {
  await expectExecGatewayProbe(gateway, skipped, env);
});
