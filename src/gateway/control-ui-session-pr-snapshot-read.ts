import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import type {
  ControlUiSessionPrReadContext,
  ControlUiSessionPrTarget,
} from "./control-ui-session-pr-read.js";
import type { ControlUiSessionPullRequestsParams } from "./control-ui-session-prs.js";

export type LoadSessionPullRequests = (
  params: ControlUiSessionPullRequestsParams,
  cacheSignal: AbortSignal | undefined,
  read: ControlUiSessionPrReadContext,
) => Promise<ControlUiSessionPullRequests>;

export function pushedSnapshot(
  result: ControlUiSessionPullRequests,
): ControlUiSessionPullRequestSnapshot {
  return {
    ...result,
    status: result.status ?? (result.rateLimited ? "rate-limited" : "ready"),
  };
}

export const UNAVAILABLE_SNAPSHOT: ControlUiSessionPullRequestSnapshot = {
  pullRequests: [],
  rateLimited: false,
  status: "unavailable",
};

/** One-shot reads reuse the subscription owner's lifetime, loader and concurrency. */
export function createControlUiSessionPrSnapshotRead(deps: {
  scope: Pick<AsyncWorkScope, "isClosing" | "track">;
  limit: <T>(run: () => Promise<T>) => Promise<T>;
  withSource: <T>(
    target: ControlUiSessionPrTarget,
    operation: (assertCurrent: () => void, sourceIdentity: string) => Promise<T>,
  ) => Promise<T>;
  load: LoadSessionPullRequests;
}) {
  return (
    target: ControlUiSessionPrTarget,
    assertCurrent: () => void,
    projection?: ControlUiSessionPrReadContext["projection"],
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const assertActive = () => {
      if (deps.scope.isClosing) {
        throw new Error("Session pull-request owner is closed");
      }
      assertCurrent();
      target.assertCurrent?.();
    };
    assertActive();
    return deps.scope.track(() =>
      deps.limit(async () => {
        assertActive();
        return await deps.withSource(target, async (assertSourceCurrent, sourceIdentity) => {
          const assertReadCurrent = () => {
            assertActive();
            assertSourceCurrent();
          };
          assertReadCurrent();
          try {
            const result = await deps.load(target.params, undefined, {
              target,
              sourceIdentity,
              projection,
              assertCurrent: assertReadCurrent,
            });
            assertReadCurrent();
            return pushedSnapshot(result);
          } catch {
            assertReadCurrent();
            return { ...UNAVAILABLE_SNAPSHOT };
          }
        });
      }),
    );
  };
}
