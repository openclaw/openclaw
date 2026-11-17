import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { isLiveTestEnabled } from "../agents/live-test-config.js";
import { proveOwnerSharingThroughCli } from "./gateway-owner-sharing-authority.test-support.js";
import { sessionKey } from "./server-methods/sessions-github-read.test-support.js";

it.skipIf(!isLiveTestEnabled())(
  "lets a real model consume CLI-owner readiness results in a human-created session",
  { timeout: 240_000 },
  async ({ signal }) => {
    assert(process.env.OPENAI_API_KEY?.trim(), "native live proof requires OPENAI_API_KEY");
    const finalText = "OWNER_SHARING_READY";
    const history = await proveOwnerSharingThroughCli({
      config: {
        plugins: { allow: ["openai"], slots: { memory: "none" } },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-6.1-sol" },
            models: { "openai/gpt-6.1-sol": { agentRuntime: { id: "openclaw" } } },
            thinkingDefault: "low",
            skipBootstrap: true,
            skills: [],
          },
        },
      },
      prompt: `This is an isolated readiness-only proof. Call github_publish action readiness exactly twice, in order: first omit publishingSessionKey; then set publishingSessionKey to ${sessionKey}. Consume both actual results. Only if both report policy.read admitted, custody qualified from worktree, and target supported, reply with exactly ${finalText}. Do not publish, request credentials, or invent results.`,
      finalText,
      waitMs: 180_000,
      signal,
      env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_BASE_URL: undefined },
    });
    expect(history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", provider: "openai", model: "gpt-6.1-sol" }),
      ]),
    );
  },
);
