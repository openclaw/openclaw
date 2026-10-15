import { afterEach, expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { adminRequestClient, callQuestionRpc, requestParams } from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

/** Own this suite's peer construction, admitted source lifetime, and native session setup. */
export function createQuestionSessionAccessFixtureOwner() {
  const sourceReleases = new Set<() => void>();
  const retainCleanup = (release: () => void) => {
    sourceReleases.add(release);
  };
  afterEach(() => {
    for (const release of sourceReleases) {
      release();
    }
    sourceReleases.clear();
  });

  function questionPeer(client: GatewayClient, connId: string) {
    const send = vi.fn();
    const socket = { readyState: 1, bufferedAmount: 0, send, close: vi.fn() };
    const ws: GatewayWsClient = {
      ...client,
      authenticatedUserProfile: client.authenticatedUserProfile
        ? {
            ...client.authenticatedUserProfile,
            avatarRevision: client.authenticatedUserProfile.avatarRevision ?? "",
          }
        : undefined,
      connId,
      usesSharedGatewayAuth: false,
      socket: socket as unknown as GatewayWsClient["socket"],
    };
    return { ws, send };
  }

  async function fixture(state: OpenClawTestState) {
    const owner = roleClient("view", "question-owner");
    const viewer = roleClient("write", "question-viewer");
    const cfg = rolePolicyConfig(["guest"]);
    cfg.gateway!.roles!.definitions.view!.scopes.push("operator.questions");
    cfg.gateway!.roles!.definitions.write!.sessions.others = "view";
    cfg.gateway!.roles!.definitions.write!.scopes.push("operator.questions");
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    owner.connect.scopes = ["operator.sessions.write"];
    viewer.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
    const sourceController = new AbortController();
    owner.internal = {
      ...owner.internal,
      operatorAccessAuthority: {
        signal: sourceController.signal,
        assertCurrent: () => sourceController.signal.throwIfAborted(),
      },
    };
    const source = await captureGatewayOperatorRunAuthority({
      client: owner,
      context: { getRuntimeConfig: () => cfg },
    });
    if (!source) {
      throw new Error("Expected admitted question source");
    }
    retainCleanup(source.release);
    const producer: GatewayClient = {
      ...owner,
      internal: {
        ...owner.internal,
        operatorRunAuthority: source.authority,
        agentRuntimeIdentity: adminRequestClient.internal!.agentRuntimeIdentity,
      },
    };
    const entry = {
      sessionId: "question-session",
      lifecycleRevision: "question-generation",
      updatedAt: 1,
      visibility: "shared" as const,
      createdActor: {
        type: "human" as const,
        source: "profile" as const,
        id: owner.authenticatedUserProfile!.profileId,
      },
    };
    const write = (delta: Partial<SessionEntry> = {}) =>
      upsertSessionEntryCore(
        { agentId: "main", sessionKey: requestParams.sessionKey },
        { ...entry, ...delta },
      );
    await write();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: requestParams.sessionKey })?.createdActor,
    ).toEqual(entry.createdActor);
    const call = (
      method: string,
      params: Record<string, unknown>,
      client = owner,
      current?: () => boolean,
    ) =>
      callQuestionRpc(method, params, {
        client,
        cfg,
        registered: true,
        hasCurrentClientAuthority: current,
      });
    const request = (id = "ordinary-question", client = producer) =>
      call("question.request", { ...requestParams, id, timeoutMs: 10_000 }, client);
    return { owner, viewer, producer, cfg, entry, write, call, request, sourceController };
  }

  return { fixture, questionPeer, retainCleanup };
}
