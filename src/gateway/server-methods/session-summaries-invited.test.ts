import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { invokeProjectMethod } from "./projects.test-support.js";
import {
  call,
  dismissPendingTaskSuggestions,
  requirePayload,
} from "./task-suggestions.test-support.js";

const methods = ["projects.list", "taskSuggestions.list"] as const;

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it.for(methods)("%s follows invited membership and drops a revoked source", async (method) => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                agents: "*",
                scopes: ["operator.read", "operator.write"],
                // @ts-expect-error Runtime invitation policy precedes config enum activation in step 13.
                sessions: { others: "invited" },
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const owner = ensureProfileForEmail("summary-owner@invited.test");
      const member = ensureProfileForEmail("summary-member@invited.test");
      const outsider = ensureProfileForEmail("summary-outsider@invited.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const scopes = ["operator.read", "operator.write"];
      const keys = ["agent:main:dashboard:summary-shared", "agent:main:dashboard:summary-unshared"];
      const taskIds: string[] = [];
      await dismissPendingTaskSuggestions();
      try {
        for (const [index, sessionKey] of keys.entries()) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId: "summary-" + index,
              updatedAt: 10 - index,
              visibility: "shared",
              execCwd: "/synthetic/summary-" + index,
              createdActor: { type: "human", source: "profile", id: owner.id },
            },
          );
          const created = await call(
            "taskSuggestions.create",
            {
              agentId: "main",
              sessionKey,
              cwd: "/synthetic/summary-" + index,
              title: "Summary task " + index,
              prompt: "Synthetic summary task",
              tldr: "Synthetic summary",
            },
            vi.fn(),
            { config: cfg },
          );
          taskIds.push((requirePayload(created) as { taskId: string }).taskId);
        }
        const scope = { agentId: "main", sessionKey: keys[0]! };
        await addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
        const list = async (profileId: string) => {
          if (method === "projects.list") {
            return invokeProjectMethod(method, { includeObserved: true }, cfg, scopes, profileId);
          }
          const client = sharingPolicyClient({ user: profileId, scopes });
          const result = await call(method, {}, vi.fn(), { client, config: cfg });
          expect(result.response?.[0]).toBe(true);
          return { ok: result.response?.[0], payload: result.response?.[1] };
        };
        const visible =
          method === "projects.list"
            ? {
                observedProjects: [
                  {
                    name: "summary-0",
                    checkouts: [{ runnerId: "gateway", path: "/synthetic/summary-0" }],
                  },
                ],
              }
            : { suggestions: [expect.objectContaining({ id: taskIds[0] })] };
        const hidden = method === "projects.list" ? { observedProjects: [] } : { suggestions: [] };
        expect(await list(member.id)).toMatchObject({ ok: true, payload: visible });
        expect(await list(outsider.id)).toMatchObject({ ok: true, payload: hidden });
        expect(await removeSessionMember(scope, member.id)).not.toBeNull();
        expect(await list(member.id)).toMatchObject({ ok: true, payload: hidden });
      } finally {
        await dismissPendingTaskSuggestions();
      }
    },
  );
});
