import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import { parseSpawnInput } from "./commands-acp/shared.js";
import { buildCommandContextForTest } from "./commands-context.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

describe("/acp group command mention arguments", () => {
  it("passes a cwd containing a configured mention pattern to the ACP parser", () => {
    const workspace = "/Users/me/norma/projects/linkauto-app";
    const body = `/acp spawn codex --cwd ${workspace}`;
    const cfg = {
      acp: { enabled: true, dispatch: { enabled: true }, backend: "acpx" },
      messages: { groupChat: { mentionPatterns: ["Norma"] } },
    } satisfies OpenClawConfig;
    const ctx = {
      Body: body,
      CommandBody: body,
      ChatType: "group",
      Provider: "telegram",
      Surface: "telegram",
    } satisfies MsgContext;
    const command = buildCommandContextForTest({
      ctx,
      cfg,
      isGroup: true,
      triggerBodyNormalized: body,
      commandAuthorized: true,
    });
    const tokens = command.commandBodyNormalized.slice("/acp spawn".length).trim().split(/\s+/);

    expect(parseSpawnInput({ ctx, cfg, command } as HandleCommandsParams, tokens)).toMatchObject({
      ok: true,
      value: { agentId: "codex", cwd: workspace },
    });
  });

  it("keeps command recognition when a configured pattern uses end anchoring", () => {
    const workspace = "/tmp/app";
    const body = `/acp spawn codex --cwd ${workspace}`;
    const cfg = {
      acp: { enabled: true, dispatch: { enabled: true }, backend: "acpx" },
      messages: { groupChat: { mentionPatterns: ["acp$"] } },
    } satisfies OpenClawConfig;
    const ctx = {
      Body: body,
      CommandBody: body,
      ChatType: "group",
      Provider: "telegram",
      Surface: "telegram",
    } satisfies MsgContext;
    const command = buildCommandContextForTest({
      ctx,
      cfg,
      isGroup: true,
      triggerBodyNormalized: body,
      commandAuthorized: true,
    });
    const tokens = command.commandBodyNormalized.slice("/acp spawn".length).trim().split(/\s+/);

    expect(command.commandBodyNormalized).toBe(body);
    expect(parseSpawnInput({ ctx, cfg, command } as HandleCommandsParams, tokens)).toMatchObject({
      ok: true,
      value: { agentId: "codex", cwd: workspace },
    });
  });
});
