import { readFile, writeFile } from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { validateClawDraftDocument } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clawDraftRevision, createClawDraft, MAX_CLAW_DRAFT_BYTES } from "../../claws/draft.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { clawsDraftsHandlers } from "./claws-drafts.js";
import type { GatewayClient } from "./client-types.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function requestDraft(
  operation: "create" | "save",
  workspace: string,
  params: Record<string, unknown> = {},
  condition?: string,
) {
  const method = `claws.drafts.${operation}`;
  const replies: Parameters<RespondFn>[] = [];
  // SAFETY: These are the live socket fields read by draft authority.
  const client = {
    connId: "draft-author",
    authenticatedUserProfile: {
      profileId: "creator",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: { role: "operator", scopes: ["operator.admin"] },
    internal: { syntheticClient: condition === "synthetic", operatorRoleActor: { kind: "system" } },
  } as GatewayClient;
  await expectDefined(
    clawsDraftsHandlers[method],
    method,
  )({
    req: { type: "req", id: operation, method },
    params: { agentId: "research", ...params },
    client,
    context: createDirectChatContext({
      getRuntimeConfig: () => ({
        agents: { entries: { research: { workspace } } },
        gateway: { controlUi: { experimental: { claws: condition !== "labs-off" } } },
      }),
      getClientConnIds: () => new Set(condition === "disconnected" ? [] : ["draft-author"]),
    }),
    respond: (...args) => {
      replies.push(args);
    },
    isWebchatConnect: () => false,
  });
  expect(replies).toHaveLength(1);
  return replies[0]!;
}

describe("Claw draft human authority", () => {
  it("registers draft methods only for administrators", () => {
    for (const method of Object.keys(clawsDraftsHandlers)) {
      expect(coreGatewayHandlers[method]).toBeDefined();
      expect(
        authorizeOperatorScopesForMethod(method, ["operator.read", "operator.write"]).allowed,
      ).toBe(false);
      expect(authorizeOperatorScopesForMethod(method, ["operator.admin"]).allowed).toBe(true);
    }
  });

  it.each([256 * 1024 + 1, MAX_CLAW_DRAFT_BYTES])(
    "saves an existing %i-byte draft while retaining revision conflicts",
    async (size) => {
      const workspace = tempDirs.make("openclaw-large-claw-draft-");
      const draft = await createClawDraft(workspace);
      const document: unknown = JSON.parse(await readFile(draft.path, "utf8"));
      if (!validateClawDraftDocument(document)) {
        throw new Error("Expected a valid initial draft");
      }
      const file = { path: "notes.md", content: "" };
      document.files = [file];
      const overhead = Buffer.byteLength(JSON.stringify(document));
      file.content = "a".repeat(size - overhead);
      const original = JSON.stringify(document);
      const edited = original.replace('"my-claw"', '"my-edit"');
      await writeFile(draft.path, original);
      const save = (content: string) =>
        requestDraft("save", workspace, {
          draftId: draft.draftId,
          content,
          expectedRevision: clawDraftRevision(original),
        });
      expect(Buffer.byteLength(original)).toBe(size);
      const result = await save(edited);
      expect(result[0], JSON.stringify(result[2])).toBe(true);
      expect(result[1]).toMatchObject({ revision: clawDraftRevision(edited) });
      expect(await readFile(draft.path, "utf8")).toBe(edited);
      expect((await save(original))[0]).toBe(false);
      expect(await readFile(draft.path, "utf8")).toBe(edited);
    },
  );

  it.each(["synthetic", "disconnected", "labs-off"])(
    "refuses %s creation before touching the workspace",
    async (condition) => {
      const reply = await requestDraft("create", "/not-a-real-claw-draft-workspace", {}, condition);
      expect(reply[0]).toBe(false);
      expect(reply[2]).toMatchObject({ code: "FORBIDDEN" });
    },
  );
});
