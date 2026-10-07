import { assert, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { getRuntimeConfig } from "../../config/io.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronService } from "../../cron/service.js";
import { cronWakeHandler } from "./cron-wake.js";
import {
  createCronCallerClient,
  createCronTestContext,
  createCronTestInvoker,
} from "./cron.validation.test-support.js";

const invokeCron = createCronTestInvoker({ wake: cronWakeHandler }, getRuntimeConfig);

it.for(
  (["preparation", "commit"] as const).flatMap((stage) =>
    (["replacement", "same object"] as const).flatMap((publication) =>
      (
        [
          "owner",
          "ambient-owner",
          "main-key",
          "global-scope",
          "store",
          "removed-agent",
          "role-scopes",
          "operator-current",
          "operator-revoked",
          "unrelated",
        ] as const
      ).map((change) => ({ stage, publication, change })),
    ),
  ),
)(
  "revalidates wake $change at $stage after $publication publication",
  async ({ stage, publication, change }, { signal }) => {
    const previous = getRuntimeConfigSnapshot();
    const previousSource = getRuntimeConfigSourceSnapshot();
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
      ...(change === "role-scopes"
        ? {
            gateway: {
              roles: {
                default: "member",
                definitions: {
                  member: {
                    agents: ["main"],
                    scopes: ["operator.write"],
                    sessions: { others: "none" },
                  },
                },
              },
            },
          }
        : {}),
    };
    setRuntimeConfigSnapshot(config, config);
    let operatorCurrent = true;
    const operatorAuthorityChange = change === "operator-current" || change === "operator-revoked";
    const client =
      change === "role-scopes" || operatorAuthorityChange
        ? createCronCallerClient("main")
        : undefined;
    if (client) {
      assert(client.internal);
      client.internal.operatorRoleActor = { kind: "operator", profileId: "wake-member" };
      client.connect.scopes = ["operator.write"];
      client.preparedSessionProfile = {
        profileId: "wake-member",
        aliases: new Set(["wake-member"]),
        role: "member",
      };
      if (operatorAuthorityChange) {
        client.internal = {
          operatorRoleActor: { kind: "operator", profileId: "wake-member" },
          operatorRunAuthority: createAdmittedRunOperatorAuthority({
            profileId: "wake-member",
            scopes: ["operator.write"],
            assertCurrent: () => {
              if (!operatorCurrent) {
                throw new Error("Wake operator authority revoked");
              }
            },
          }),
        };
      }
    }
    const publishReload = () => {
      const replacement = structuredClone(config);
      switch (change) {
        case "owner":
          replacement.agents = { ownership: "explicit", entries: { other: {} } };
          break;
        case "ambient-owner":
          replacement.agents = {
            ...replacement.agents,
            defaults: { systemAgent: { agentId: "ops" } },
          };
          break;
        case "main-key":
          replacement.session = { mainKey: "other" };
          break;
        case "global-scope":
          replacement.session = { scope: "global" };
          break;
        case "store":
          replacement.session = { store: "/synthetic/wake/{agentId}/sessions.json" };
          break;
        case "removed-agent":
          replacement.agents = { ...replacement.agents, entries: { main: {} } };
          break;
        case "role-scopes":
          replacement.gateway = {
            roles: {
              default: "member",
              definitions: {
                member: {
                  agents: ["main"],
                  scopes: [],
                  sessions: { others: "none" },
                },
              },
            },
          };
          break;
        case "unrelated":
          replacement.messages = { responsePrefix: "test" };
          break;
        case "operator-current":
        case "operator-revoked":
          operatorCurrent = change === "operator-current";
          break;
      }
      const next = publication === "same object" ? Object.assign(config, replacement) : replacement;
      setRuntimeConfigSnapshot(next, next);
    };
    const entered = createDeferred();
    const release = createDeferred();
    const context = createCronTestContext(undefined, getRuntimeConfig);
    const committed: Array<Parameters<CronService["wake"]>[0]> = [];
    context.cron.prepareWake.mockImplementationOnce(async () => {
      if (stage === "preparation") {
        entered.resolve();
        await release.promise;
      }
    });
    context.cron.wake.mockImplementationOnce((options) => {
      if (stage === "commit") {
        publishReload();
      }
      options.commitGuard?.();
      committed.push(options);
      return { ok: true };
    });
    const invocation = invokeCron(
      "wake",
      {
        mode: "now",
        text: "bound wake",
        ...(change === "ambient-owner"
          ? {}
          : {
              sessionKey: change === "removed-agent" ? "agent:ops:main" : "main",
              agentId: change === "removed-agent" ? "ops" : "main",
            }),
      },
      { context, client },
    );
    const outcome = invocation.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      if (stage === "preparation") {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, invocation, "wake settled before preparation"),
          signal,
        );
        publishReload();
        release.resolve();
      }
      const error = await withinTest(outcome, signal);
      if (change === "unrelated" || change === "operator-current") {
        expect(error).toBeUndefined();
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({ createIfMissing: true });
      } else {
        expect(committed).toEqual([]);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain(
          change === "operator-revoked"
            ? "Wake operator authority revoked"
            : change === "role-scopes"
              ? "Your operator role changed"
              : "Wake configuration changed during preparation",
        );
      }
    } finally {
      release.resolve();
      await outcome;
      if (previous) {
        setRuntimeConfigSnapshot(previous, previousSource ?? undefined);
      } else {
        clearRuntimeConfigSnapshot();
      }
    }
  },
);
