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

function mockCodexProviderSnapshot(provider: Record<string, unknown>): void {
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
}

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
    requireTerminalNote({ title: "Gateway", messageIncludes: execHealthMessage });
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

function requireTerminalNote(params: { title?: string; messageIncludes?: string }) {
  const note = terminalNoteMock.mock.calls.find(
    ([message, title]) =>
      (params.title === undefined || title === params.title) &&
      (params.messageIncludes === undefined || String(message).includes(params.messageIncludes)),
  );
  if (!note) {
    throw new Error(
      `expected terminal note${params.title ? ` titled ${params.title}` : ""}${
        params.messageIncludes ? ` containing ${params.messageIncludes}` : ""
      }`,
    );
  }
  return note;
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

  requireTerminalNote({
    title: "State integrity",
    messageIncludes: "State directory was missing at doctor start",
  });
});

it("routes browser readiness through health contributions", async () => {
  const { noteChromeMcpBrowserReadiness } = await import("./doctor-browser.js");
  const browserReadiness = vi.mocked(noteChromeMcpBrowserReadiness);
  browserReadiness.mockClear();
  mockDoctorConfigSnapshot({
    config: {
      browser: {
        defaultProfile: "user",
      },
    },
  });

  await runDoctorNonInteractive();

  expect(browserReadiness).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ browser: { defaultProfile: "user" } }),
  );
});

it("warns about active OpenCode provider overrides", async () => {
  mockDoctorConfigSnapshot({
    config: {
      models: {
        providers: {
          opencode: {
            api: "openai-completions",
            baseUrl: "https://opencode.ai/zen/v1",
          },
          "opencode-go": {
            api: "openai-completions",
            baseUrl: "https://opencode.ai/zen/go/v1",
          },
        },
      },
    },
  });

  await runDoctorNonInteractive();

  const warned = terminalNoteMock.mock.calls.some(
    ([message, title]) =>
      title === "OpenCode" &&
      String(message).includes("models.providers.opencode") &&
      String(message).includes("models.providers.opencode-go"),
  );
  expect(warned).toBe(true);
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
  mockCodexProviderSnapshot(provider);
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
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    },
  });

  await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: undefined }, runDoctorNonInteractive);

  const gatewayAuthNote = requireTerminalNote({ title: "Gateway auth" });
  expect(String(gatewayAuthNote[0])).toContain(
    "Gateway token SecretRef could not be resolved: gateway.auth.token SecretRef is unresolved",
  );
  requireTerminalNote({
    title: "Gateway auth",
    messageIncludes: "Doctor will not overwrite gateway.auth.token with a plaintext value.",
  });
  expect(transformConfigFile).not.toHaveBeenCalled();
});

it.each([
  [
    "token mode with env password",
    { mode: "local", auth: { mode: "token", token: execRef("gateway/token") } },
    true,
    { OPENCLAW_GATEWAY_PASSWORD: "fallback-password" },
  ],
  [
    "ambiguous exec refs",
    {
      mode: "local",
      auth: { token: execRef("gateway/token"), password: execRef("gateway/password") },
    },
    true,
    {},
  ],
  [
    "remote exec token with env token",
    {
      mode: "remote",
      remote: { url: "https://gateway.example.test", token: execRef("gateway/remote-token") },
    },
    true,
    { OPENCLAW_GATEWAY_TOKEN: "fallback-token" },
  ],
  [
    "remote with local exec fallback",
    {
      mode: "remote",
      auth: { mode: "password", token: execRef("gateway/token") },
      remote: { url: "https://gateway.example.test" },
    },
    true,
    {},
  ],
  [
    "non-token auth with dormant exec token",
    {
      mode: "local",
      auth: {
        mode: "password",
        password: "configured-password",
        token: execRef("gateway/token"),
      },
    },
    false,
    {},
  ],
  [
    "env token winning over exec password",
    { mode: "local", auth: { password: execRef("gateway/password") } },
    false,
    { OPENCLAW_GATEWAY_TOKEN: "fallback-token" },
  ],
  [
    "exec password with env password",
    { mode: "local", auth: { mode: "password", password: execRef("gateway/password") } },
    true,
    { OPENCLAW_GATEWAY_PASSWORD: "fallback-password" },
  ],
  [
    "remote exec password with winning env token",
    {
      mode: "remote",
      auth: { mode: "password" },
      remote: {
        url: "https://gateway.example.test",
        password: execRef("gateway/remote-password"),
      },
    },
    false,
    { OPENCLAW_GATEWAY_TOKEN: "fallback-token" },
  ],
  [
    "remote exec token with winning env password",
    {
      mode: "remote",
      auth: { mode: "token" },
      remote: { url: "https://gateway.example.test", token: execRef("gateway/remote-token") },
    },
    false,
    { OPENCLAW_GATEWAY_PASSWORD: "fallback-password" },
  ],
  [
    "local auth with dormant remote exec refs",
    {
      mode: "local",
      auth: { mode: "token", token: "configured-token" },
      remote: { url: "https://gateway.example.test", token: execRef("gateway/remote-token") },
    },
    false,
    {},
  ],
] as const)("gateway probe selection: %s", async (_label, gateway, skipped, env) => {
  await expectExecGatewayProbe(gateway, skipped, env);
});
