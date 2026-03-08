import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDoctorRuntime,
  ensureAuthProfileStore,
  mockDoctorConfigSnapshot,
  note,
} from "./doctor.e2e-harness.js";
import "./doctor.fast-path-mocks.js";

vi.doUnmock("./doctor-state-integrity.js");

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command", () => {
  beforeAll(async () => {
    ({ doctorCommand } = await import("./doctor.js"));
  });

  it("warns when the state directory is missing", async () => {
    mockDoctorConfigSnapshot();

    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-missing-state-"));
    fs.rmSync(missingDir, { recursive: true, force: true });
    process.env.OPENCLAW_STATE_DIR = missingDir;
    note.mockClear();

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const stateNote = note.mock.calls.find((call) => call[1] === "State integrity");
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
          },
        },
      },
    });

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const warned = note.mock.calls.some(
      ([message, title]) =>
        title === "OpenCode Zen" && String(message).includes("models.providers.opencode"),
    );
    expect(warned).toBe(true);
  });

  it("warns when a legacy openai-codex provider override shadows Codex OAuth", async () => {
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

    const warned = note.mock.calls.some(
      ([message, title]) =>
        title === "Codex OAuth" && String(message).includes("models.providers.openai-codex"),
    );
    expect(warned).toBe(true);
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

    const warned = note.mock.calls.some(([, title]) => title === "Codex OAuth");
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
    note.mockClear();

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

    const warned = note.mock.calls.some(([message]) =>
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

    note.mockClear();

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const gatewayAuthNote = note.mock.calls.find((call) => call[1] === "Gateway auth");
    expect(gatewayAuthNote).toBeTruthy();
    expect(String(gatewayAuthNote?.[0])).toContain("gateway.auth.mode is unset");
    expect(String(gatewayAuthNote?.[0])).toContain("openclaw config set gateway.auth.mode token");
    expect(String(gatewayAuthNote?.[0])).toContain(
      "openclaw config set gateway.auth.mode password",
    );
  });
});
