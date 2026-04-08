import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDoctorRuntime,
  ensureAuthProfileStore,
  mockDoctorConfigSnapshot,
} from "./doctor.e2e-harness.js";
import { loadDoctorCommandForTest, terminalNoteMock } from "./doctor.note-test-helpers.js";
import "./doctor.fast-path-mocks.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command", () => {
  beforeEach(async () => {
    doctorCommand = await loadDoctorCommandForTest({
      unmockModules: ["../flows/doctor-health-contributions.js", "./doctor-state-integrity.js"],
    });
  });

  it("warns when the state directory is missing", async () => {
    mockDoctorConfigSnapshot();

    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-missing-state-"));
    fs.rmSync(missingDir, { recursive: true, force: true });
    process.env.OPENCLAW_STATE_DIR = missingDir;
    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const stateNote = terminalNoteMock.mock.calls.find(([message]) =>
      String(message).includes("state directory missing"),
    );
    expect(stateNote).toBeTruthy();
    expect(String(stateNote?.[0])).toContain("CRITICAL");
  });

  it("warns about opencode provider overrides", async () => {
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

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = terminalNoteMock.mock.calls.some(
      ([message, title]) =>
        title === "OpenCode" &&
        String(message).includes("models.providers.opencode") &&
        String(message).includes("models.providers.opencode-go"),
    );
    expect(warned).toBe(true);
  });

  it("warns when a legacy openai-codex provider override shadows configured Codex OAuth", async () => {
    mockDoctorConfigSnapshot({
      config: {
        models: {
          providers: {
            "openai-codex": {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
            },
          },
        },
        auth: {
          profiles: {
            "openai-codex:user@example.com": {
              provider: "openai-codex",
              mode: "oauth",
              email: "user@example.com",
            },
          },
        },
      },
    });
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = terminalNoteMock.mock.calls.some(
      ([message, title]) =>
        title === "Codex OAuth" && String(message).includes("models.providers.openai-codex"),
    );
    expect(warned).toBe(true);
  });

  it("warns when a legacy openai-codex provider override shadows stored Codex OAuth", async () => {
    mockDoctorConfigSnapshot({
      config: {
        models: {
          providers: {
            "openai-codex": {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
            },
          },
        },
      },
    });
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:user@example.com": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          email: "user@example.com",
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = terminalNoteMock.mock.calls.some(
      ([message, title]) =>
        title === "Codex OAuth" && String(message).includes("models.providers.openai-codex"),
    );
    expect(warned).toBe(true);
  });

  it("warns when an inline openai-codex model keeps the legacy OpenAI transport", async () => {
    mockDoctorConfigSnapshot({
      config: {
        models: {
          providers: {
            "openai-codex": {
              models: [
                {
                  id: "gpt-5.4",
                  api: "openai-responses",
                },
              ],
            },
          },
        },
        auth: {
          profiles: {
            "openai-codex:user@example.com": {
              provider: "openai-codex",
              mode: "oauth",
              email: "user@example.com",
            },
          },
        },
      },
    });
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = terminalNoteMock.mock.calls.some(
      ([message, title]) =>
        title === "Codex OAuth" && String(message).includes("legacy transport override"),
    );
    expect(warned).toBe(true);
  });

  it("does not warn for a custom openai-codex proxy override", async () => {
    mockDoctorConfigSnapshot({
      config: {
        models: {
          providers: {
            "openai-codex": {
              api: "openai-responses",
              baseUrl: "https://custom.example.com",
            },
          },
        },
        auth: {
          profiles: {
            "openai-codex:user@example.com": {
              provider: "openai-codex",
              mode: "oauth",
              email: "user@example.com",
            },
          },
        },
      },
    });
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = terminalNoteMock.mock.calls.some(([, title]) => title === "Codex OAuth");
    expect(warned).toBe(false);
  });

  it("does not warn for header-only openai-codex overrides", async () => {
    mockDoctorConfigSnapshot({
      config: {
        models: {
          providers: {
            "openai-codex": {
              baseUrl: "https://custom.example.com",
              headers: { "X-Custom-Auth": "token-123" },
              models: [{ id: "gpt-5.4" }],
            },
          },
        },
        auth: {
          profiles: {
            "openai-codex:user@example.com": {
              provider: "openai-codex",
              mode: "oauth",
              email: "user@example.com",
            },
          },
        },
      },
    });
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = terminalNoteMock.mock.calls.some(([, title]) => title === "Codex OAuth");
    expect(warned).toBe(false);
  });
  it("does not warn about an openai-codex provider override without Codex OAuth", async () => {
    mockDoctorConfigSnapshot({
      config: {
        models: {
          providers: {
            "openai-codex": {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
            },
          },
        },
      },
    });
    ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = terminalNoteMock.mock.calls.some(([, title]) => title === "Codex OAuth");
    expect(warned).toBe(false);
  });

  it("skips gateway auth warning when OPENCLAW_GATEWAY_TOKEN is set", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: { mode: "local" },
      },
    });

    const prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-1234567890";
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (prevToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
      }
    }

    const warned = terminalNoteMock.mock.calls.some(([message]) =>
      String(message).includes("Gateway auth is off or missing a token"),
    );
    expect(warned).toBe(false);
  });

  it("warns when token and password are both configured and gateway.auth.mode is unset", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            token: "token-value",
            password: "password-value", // pragma: allowlist secret
          },
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const gatewayAuthNote = terminalNoteMock.mock.calls.find((call) => call[1] === "Gateway auth");
    expect(gatewayAuthNote).toBeTruthy();
    expect(String(gatewayAuthNote?.[0])).toContain("gateway.auth.mode is unset");
    expect(String(gatewayAuthNote?.[0])).toContain("openclaw config set gateway.auth.mode token");
    expect(String(gatewayAuthNote?.[0])).toContain(
      "openclaw config set gateway.auth.mode password",
    );
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

    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    }

    const gatewayAuthNote = terminalNoteMock.mock.calls.find((call) => call[1] === "Gateway auth");
    expect(gatewayAuthNote).toBeTruthy();
    expect(String(gatewayAuthNote?.[0])).toContain(
      "Gateway token is managed via SecretRef and is currently unavailable.",
    );
    expect(String(gatewayAuthNote?.[0])).toContain(
      "Doctor will not overwrite gateway.auth.token with a plaintext value.",
    );
  });
});
