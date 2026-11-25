import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createDoctorPrompter } from "../../doctor-prompter.js";
import type { DoctorOptions } from "../../doctor.types.js";
import { maybeOfferModelAllowlistWildcards } from "./legacy-runtime-model-policy.js";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), note: vi.fn() }));

// The terminal prompt and note are the operator boundary; the gating and config change stay real.
vi.mock("@clack/prompts", async (importActual) => ({
  ...(await importActual<typeof import("@clack/prompts")>()),
  confirm: mocks.confirm,
}));
// mock-isolation: notes write to the terminal; tests read the rendered lines from the spy.
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

const originalStdinIsTTY = process.stdin.isTTY;

const copied = [
  "openai/gpt-6-luna",
  "openai/gpt-6-astra",
  "clawrouter/anthropic/claude-fable-5-1",
  "clawrouter/anthropic/claude-opus-5-5",
];

function config(allow: string[], models = copied): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: Object.fromEntries(models.map((ref) => [ref, {}])),
        modelPolicy: { allow },
      },
    },
  };
}

async function offer(cfg: OpenClawConfig, options: DoctorOptions, tty = true) {
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  const prompter = createDoctorPrompter({
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options,
  });
  return maybeOfferModelAllowlistWildcards({ cfg, prompter });
}

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
  vi.unstubAllEnvs();
  mocks.confirm.mockReset();
  mocks.note.mockReset();
});

describe("doctor model allowlist wildcard offer", () => {
  it("replaces a copied list with provider-family wildcards when the operator accepts", async () => {
    mocks.confirm.mockResolvedValue(true);

    const { config: next, changes } = await offer(config(copied), {});

    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/*",
      "clawrouter/anthropic/*",
    ]);
    expect(Object.keys(next.agents?.defaults?.models ?? {})).toEqual(copied);
    // The writer announces the change after it commits, so the offer prints no change panel.
    expect(changes).toEqual([
      "- agents.defaults.modelPolicy.allow: openai/*, clawrouter/anthropic/*",
    ]);
    expect(mocks.note).toHaveBeenCalledOnce();
  });

  it("keeps the list when the operator declines", async () => {
    mocks.confirm.mockResolvedValue(false);
    const cfg = config(copied);

    expect((await offer(cfg, { repair: true })).config).toBe(cfg);
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });

  it.each([
    ["--yes", { yes: true }, true],
    ["--non-interactive", { nonInteractive: true, repair: true }, true],
    ["no terminal", { repair: true }, false],
  ] as const)("never changes the list with %s", async (_label, options, tty) => {
    const cfg = config(copied);

    expect((await offer(cfg, options, tty)).config).toBe(cfg);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("never asks during an update", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    const cfg = config(copied);

    expect((await offer(cfg, {})).config).toBe(cfg);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["a subset of the model map", copied.slice(0, 3)],
    ["an existing wildcard", [...copied.slice(0, 3), "openai/*"]],
  ])("does not offer for a handcrafted list: %s", async (_label, allow) => {
    const cfg = config(allow);

    expect((await offer(cfg, {})).config).toBe(cfg);
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("offers for a per-agent copy of the model map", async () => {
    mocks.confirm.mockResolvedValue(true);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { models: { "openai/gpt-6-luna": {} } },
        entries: { main: { modelPolicy: { allow: ["openai/gpt-6-luna"] } } },
      },
    };

    const { config: next } = await offer(cfg, {});

    expect(next.agents?.entries?.main?.modelPolicy?.allow).toEqual(["openai/*"]);
  });
});
