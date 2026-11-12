// Doctor missing-state e2e tests cover warning output when the state directory is absent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const OPENAI_PROVIDER_ID = "openai";
const LEGACY_CODEX_PROVIDER_ID = "openai-codex";
const CODEX_PROFILE_ID = "openai:user@example.com";
const CODEX_PROFILE_EMAIL = "user@example.com";

function configCodexOAuthProfile() {
  return {
    provider: OPENAI_PROVIDER_ID,
    mode: "oauth",
    email: CODEX_PROFILE_EMAIL,
  };
}

function mockAuthProfileStore(profiles: Record<string, unknown> = {}): void {
  ensureAuthProfileStore.mockReturnValue({
    version: 1,
    profiles,
  });
}

function mockCodexProviderSnapshot(params: {
  provider: Record<string, unknown>;
  withConfigOAuth?: boolean;
}): void {
  mockDoctorConfigSnapshot({
    config: {
      models: {
        providers: {
          [LEGACY_CODEX_PROVIDER_ID]: params.provider,
        },
      },
      ...(params.withConfigOAuth
        ? {
            auth: {
              profiles: {
                [CODEX_PROFILE_ID]: configCodexOAuthProfile(),
              },
            },
          }
        : {}),
    },
  });
}

function execRef(id: string) {
  return { source: "exec" as const, provider: "default", id };
}

function mockExecGateway(gateway: NonNullable<OpenClawConfig["gateway"]>): void {
  mockDoctorConfigSnapshot({
    config: {
      gateway,
      secrets: { providers: { default: { source: "exec", command: process.execPath } } },
    },
  });
}

async function runDoctorNonInteractive(): Promise<void> {
  await doctorCommand(createDoctorRuntime(), {
    nonInteractive: true,
    workspaceSuggestions: false,
  });
}

function hasCodexOAuthWarning(): boolean {
  return terminalNoteMock.mock.calls.some(([, title]) => title === "Codex OAuth");
}

const GATEWAY_EXEC_SECRET_REF_SKIP_NOTE =
  "Gateway health checks skipped because gateway credentials use an exec SecretRef.";

function hasGatewayExecSecretRefSkipNote(): boolean {
  return terminalNoteMock.mock.calls.some(
    ([message, title]) =>
      title === "Gateway" && String(message).includes(GATEWAY_EXEC_SECRET_REF_SKIP_NOTE),
  );
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

describe("doctor command", () => {
  beforeAll(async () => {
    vi.doUnmock("../flows/doctor-health-contributions.js");
    vi.doUnmock("./doctor-state-integrity.js");
    ({ doctorCommand } = await import("./doctor.js"));
  });

  beforeEach(() => {
    terminalNoteMock.mockClear();
  });

  it("reports a missing state directory without initializing it", async () => {
    mockDoctorConfigSnapshot();

    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-missing-state-"));
    fs.rmSync(missingDir, { recursive: true, force: true });
    await withEnvAsync({ OPENCLAW_STATE_DIR: missingDir }, async () => {
      await runDoctorNonInteractive();
    });

    const warning = requireTerminalNote({
      title: "State integrity",
      messageIncludes: "CRITICAL: state directory missing",
    });
    expect(String(warning[0])).toContain(missingDir);
    expect(fs.existsSync(missingDir)).toBe(false);
  });

  it("routes browser readiness through health contributions", async () => {
    const { collectBrowserReadinessFindings } = await import("./doctor-browser.js");
    const browserReadiness = vi.mocked(collectBrowserReadinessFindings);
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

  it("does not warn for a custom OpenAI proxy override", async () => {
    mockCodexProviderSnapshot({
      provider: {
        api: "openai-responses",
        baseUrl: "https://custom.example.com",
      },
      withConfigOAuth: true,
    });
    mockAuthProfileStore();

    await runDoctorNonInteractive();

    expect(hasCodexOAuthWarning()).toBe(false);
  });

  it("does not warn for header-only OpenAI overrides", async () => {
    mockCodexProviderSnapshot({
      provider: {
        baseUrl: "https://custom.example.com",
        headers: { "X-Custom-Auth": "token-123" },
        models: [{ id: "gpt-5.4" }],
      },
      withConfigOAuth: true,
    });
    mockAuthProfileStore();

    await runDoctorNonInteractive();

    expect(hasCodexOAuthWarning()).toBe(false);
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

  it.each<[string, NonNullable<OpenClawConfig["gateway"]>, NodeJS.ProcessEnv, boolean]>([
    [
      "skips token-mode exec token probes even when env password is set",
      { mode: "local", auth: { mode: "token", token: execRef("gateway/token") } },
      { OPENCLAW_GATEWAY_PASSWORD: "fallback-password" },
      true,
    ],
    [
      "skips password-mode exec password probes even when env token is set",
      { mode: "local", auth: { mode: "password", password: execRef("gateway/password") } },
      { OPENCLAW_GATEWAY_TOKEN: "fallback-token" },
      true,
    ],
    [
      "skips gateway health probes for ambiguous exec SecretRefs",
      {
        mode: "local",
        auth: { token: execRef("gateway/token"), password: execRef("gateway/password") },
      },
      {},
      true,
    ],
    [
      "skips remote exec token probes even when env token fallback is set",
      {
        mode: "remote",
        remote: { url: "https://gateway.example.test", token: execRef("gateway/remote-token") },
      },
      { OPENCLAW_GATEWAY_TOKEN: "fallback-token" },
      true,
    ],
    [
      "skips remote probes when local fallback credentials use exec",
      {
        mode: "remote",
        auth: { mode: "password", token: execRef("gateway/token") },
        remote: { url: "https://gateway.example.test" },
      },
      {},
      true,
    ],
    [
      "keeps gateway health probes for non-token auth with exec SecretRefs",
      {
        mode: "local",
        auth: {
          mode: "password",
          password: "configured-password",
          token: execRef("gateway/token"),
        },
      },
      {},
      false,
    ],
    [
      "keeps gateway health probes when env token wins over an exec password ref",
      { mode: "local", auth: { password: execRef("gateway/password") } },
      { OPENCLAW_GATEWAY_TOKEN: "fallback-token" },
      false,
    ],
    [
      "skips password-mode probes when configured password is an exec SecretRef",
      { mode: "local", auth: { mode: "password", password: execRef("gateway/password") } },
      { OPENCLAW_GATEWAY_PASSWORD: "fallback-password" },
      true,
    ],
    [
      "keeps remote gateway health probes when env token wins over an exec password ref",
      {
        mode: "remote",
        auth: { mode: "password" },
        remote: {
          url: "https://gateway.example.test",
          password: execRef("gateway/remote-password"),
        },
      },
      { OPENCLAW_GATEWAY_TOKEN: "fallback-token" },
      false,
    ],
    [
      "keeps remote gateway health probes when env password wins over an exec token ref",
      {
        mode: "remote",
        auth: { mode: "token" },
        remote: { url: "https://gateway.example.test", token: execRef("gateway/remote-token") },
      },
      { OPENCLAW_GATEWAY_PASSWORD: "fallback-password" },
      false,
    ],
    [
      "keeps local gateway health probes when only dormant remote refs use exec",
      {
        mode: "local",
        auth: { mode: "token", token: "configured-token" },
        remote: { url: "https://gateway.example.test", token: execRef("gateway/remote-token") },
      },
      {},
      false,
    ],
  ])("%s", async (_name, gateway, env, skip) => {
    mockExecGateway(gateway);
    if (skip) {
      callGateway.mockClear();
    }
    await withEnvAsync(env, runDoctorNonInteractive);
    if (skip) {
      expect(callGateway).not.toHaveBeenCalled();
      requireTerminalNote({
        title: "Gateway",
        messageIncludes: GATEWAY_EXEC_SECRET_REF_SKIP_NOTE,
      });
    } else {
      expect(hasGatewayExecSecretRefSkipNote()).toBe(false);
    }
  });
});
