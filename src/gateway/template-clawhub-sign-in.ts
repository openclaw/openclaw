import { randomUUID } from "node:crypto";
import type { TemplatesDraftsSignInResult } from "../../packages/gateway-protocol/src/schema/template-drafts.js";
import { ClawHubRequestError, fetchClawHubJson } from "../infra/clawhub-client.js";
import { pollClawHubDeviceSignIn, startClawHubDeviceSignIn } from "../infra/clawhub-device-auth.js";
import { savePersonalTemplateClawHubToken } from "../secrets/store/secret-store-clawhub-template.js";
import { TemplateProjectError } from "../templates/project.js";

type Target = {
  profileId: string;
  baseUrl: string;
  sourceSessionKey: string;
  draftId: string;
  assertCurrent: () => void;
};

export async function readTemplateClawHubPublisher(baseUrl: string, token: string) {
  const result = await fetchClawHubJson<{ user?: { handle?: string | null } }>({
    baseUrl,
    token,
    path: "/api/v1/whoami",
  }).catch((error: unknown) => {
    if (error instanceof ClawHubRequestError && error.status === 401) {
      return null;
    }
    throw error;
  });
  if (!result) {
    return null;
  }
  const handle = result.user?.handle?.trim().toLowerCase();
  if (!handle || !/^[a-z0-9][a-z0-9._-]*$/.test(handle)) {
    throw new TemplateProjectError(
      "clawhub_identity_required",
      "Your ClawHub account needs a personal publisher handle.",
    );
  }
  return handle;
}

type Device = Awaited<ReturnType<typeof startClawHubDeviceSignIn>>;
type Attempt = {
  id: string;
  target: [string, string];
  start: Promise<Device>;
  expiresAt: number;
  nextPollAt: number;
  inFlight?: Promise<TemplatesDraftsSignInResult>;
  committing?: true;
  result?: TemplatesDraftsSignInResult;
};

const defaultDependencies = {
  now: Date.now,
  start: startClawHubDeviceSignIn,
  poll: pollClawHubDeviceSignIn,
  verify: readTemplateClawHubPublisher,
  save: savePersonalTemplateClawHubToken,
};

/** Each Gateway owns one bounded exchange per person and registry. Only the public URL/receipt leaves it. */
export function createTemplateClawHubSignIn(dependencies = defaultDependencies) {
  const attempts = new Map<string, Attempt>();
  const key = (target: Target) => JSON.stringify([target.profileId, target.baseUrl]);
  const matches = (target: Target, attempt: Attempt) =>
    target.sourceSessionKey === attempt.target[0] && target.draftId === attempt.target[1];
  const gone = { status: "expired" } as const;
  const pending = (attempt: Attempt, device: Device) => ({
    status: "pending" as const,
    requestId: attempt.id,
    verificationUrl: device.verificationUrl,
    userCode: device.userCode,
    expiresAt: attempt.expiresAt,
    pollAfterMs: Math.max(250, attempt.nextPollAt - dependencies.now()),
  });
  return {
    async start(target: Target): Promise<TemplatesDraftsSignInResult> {
      target.assertCurrent();
      const owner = key(target);
      const now = dependencies.now();
      for (const [id, attempt] of attempts) {
        if (!attempt.inFlight && attempt.expiresAt <= now) {
          attempts.delete(id);
        }
      }
      let attempt = attempts.get(owner);
      if (attempt?.result) {
        attempts.delete(owner);
        attempt = undefined;
      }
      if (attempt && !matches(target, attempt)) {
        throw new TemplateProjectError(
          "clawhub_sign_in_in_progress",
          "Finish the ClawHub sign-in in the conversation where you started it, or wait for it to expire.",
        );
      }
      if (!attempt) {
        if (attempts.size >= 128) {
          throw new TemplateProjectError(
            "clawhub_sign_in_busy",
            "ClawHub sign-in is busy. Try again shortly.",
          );
        }
        const fresh: Attempt = {
          id: randomUUID(),
          target: [target.sourceSessionKey, target.draftId],
          start: Promise.resolve().then(() =>
            dependencies.start({ baseUrl: target.baseUrl, timeoutMs: 10_000 }),
          ),
          expiresAt: now + 15 * 60_000,
          nextPollAt: now,
        };
        attempts.set(owner, fresh);
        attempt = fresh;
        void fresh.start.then(
          (device) => {
            const startedAt = dependencies.now();
            fresh.expiresAt = startedAt + device.expiresInMs;
            fresh.nextPollAt = startedAt + device.intervalMs;
          },
          () => {
            if (attempts.get(owner) === fresh) {
              attempts.delete(owner);
            }
          },
        );
      }
      const device = await attempt.start;
      target.assertCurrent();
      return attempt.result ?? pending(attempt, device);
    },
    async poll(target: Target, requestId: string): Promise<TemplatesDraftsSignInResult> {
      target.assertCurrent();
      const attempt = attempts.get(key(target));
      if (!attempt || attempt.id !== requestId || !matches(target, attempt)) {
        return gone;
      }
      if (attempt.result) {
        return attempt.result;
      }
      // Join an active exchange after start has settled; concurrent polls can
      // arrive during that await. Only the first continuation starts the exchange.
      const device = await attempt.start;
      target.assertCurrent();
      const now = dependencies.now();
      if (attempt.result) {
        return attempt.result;
      }
      if (attempt.inFlight) {
        const shared = await attempt.inFlight;
        target.assertCurrent();
        return shared;
      }
      if (now >= attempt.expiresAt) {
        return (attempt.result = gone);
      }
      if (now < attempt.nextPollAt) {
        return pending(attempt, device);
      }
      attempt.nextPollAt = now + device.intervalMs;
      const exchange = (async (): Promise<TemplatesDraftsSignInResult> => {
        const result = await dependencies.poll(device.deviceCode, {
          baseUrl: target.baseUrl,
          timeoutMs: 10_000,
        });
        const current = () => {
          target.assertCurrent();
          if (attempt.result || dependencies.now() >= attempt.expiresAt) {
            throw new Error("This ClawHub approval request has ended. Start a new sign-in.");
          }
        };
        if (attempt.result) {
          return attempt.result;
        }
        if (dependencies.now() >= attempt.expiresAt) {
          return (attempt.result = gone);
        }
        current();
        if (result.kind === "pending") {
          return pending(attempt, device);
        }
        if (result.kind !== "authorized") {
          return (attempt.result = { status: result.kind });
        }
        const publisher = await dependencies.verify(target.baseUrl, result.token);
        if (attempt.result) {
          return attempt.result;
        }
        current();
        if (!publisher) {
          return (attempt.result = { status: "failed" });
        }
        attempt.committing = true;
        await dependencies.save({ ...target, assertCurrent: current }, result.token);
        return (attempt.result = { status: "connected" });
      })();
      attempt.inFlight = exchange;
      try {
        return await exchange;
      } catch (error) {
        attempt.result ??= dependencies.now() >= attempt.expiresAt ? gone : { status: "failed" };
        throw error;
      } finally {
        attempt.inFlight = undefined;
        attempt.committing = undefined;
      }
    },
    cancel(target: Target, requestId: string): TemplatesDraftsSignInResult {
      target.assertCurrent();
      const attempt = attempts.get(key(target));
      if (!attempt || attempt.id !== requestId || !matches(target, attempt)) {
        return gone;
      }
      if (attempt.committing) {
        return { status: "finishing" };
      }
      return (attempt.result ??= { status: "cancelled" });
    },
  };
}
