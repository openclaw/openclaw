import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerProfile } from "../../plugins/types.js";
import {
  prepareSessionGuestAuthority,
  readSessionGuestBinding,
  SessionGuestAccessRevokedError,
  type SessionGuestBinding,
} from "./session-guest.js";
import { boundedWorkerError } from "./worker-error.js";

/** Retains existing admission capabilities; attachment lifecycle remains the resource owner. */
export function createSessionGuestAuthorityOwner(options: {
  getConfig: () => OpenClawConfig;
  getProfile: (environmentId: string) => WorkerProfile | undefined;
  retire: (binding: SessionGuestBinding, environmentId: string) => Promise<unknown>;
  warn: (message: string) => void;
}) {
  const authorities = new Map<
    string,
    {
      binding: SessionGuestBinding;
      authority: Awaited<ReturnType<typeof prepareSessionGuestAuthority>>;
      release: () => void;
    }
  >();
  const release = (environmentId: string) => {
    authorities.get(environmentId)?.release();
    authorities.delete(environmentId);
  };
  const retain = async (binding: SessionGuestBinding, environmentId: string) => {
    const retained = authorities.get(environmentId);
    if (retained) {
      if (
        retained.binding.profileId !== binding.profileId ||
        retained.binding.sessionId !== binding.sessionId ||
        retained.binding.grant?.pluginId !== binding.grant?.pluginId ||
        retained.binding.grant?.grantId !== binding.grant?.grantId
      ) {
        throw new Error("Conversation environment belongs to another guest authority");
      }
      retained.authority.assertCurrent();
      return retained.authority;
    }
    const authority = await prepareSessionGuestAuthority(binding, options.getConfig);
    const retire = () => {
      void options
        .retire(binding, environmentId)
        .catch((error: unknown) =>
          options.warn(
            "Guest environment cleanup remains pending for " +
              environmentId +
              ": " +
              boundedWorkerError(error),
          ),
        );
    };
    authorities.set(environmentId, {
      binding,
      authority,
      release: () => {
        authority.signal?.removeEventListener("abort", retire);
        authority.release();
      },
    });
    authority.signal?.addEventListener("abort", retire, { once: true });
    if (authority.signal?.aborted) {
      retire();
    }
    authority.assertCurrent();
    return authority;
  };
  return {
    get: (environmentId: string) => authorities.get(environmentId),
    retain,
    release,
    releaseAll: () => {
      for (const id of authorities.keys()) {
        release(id);
      }
    },
    assertPrincipal(
      this: void,
      environmentId: string,
      sessionId: string,
      principalId?: string,
      requiresIsolatedEnvironment?: true,
    ) {
      const profile = options.getProfile(environmentId);
      const guest = profile && readSessionGuestBinding(profile);
      if (!guest) {
        if (requiresIsolatedEnvironment) {
          throw new Error("This caller requires an isolated guest environment");
        }
        return;
      }
      const held = authorities.get(environmentId);
      if (guest.profileId !== principalId || guest.sessionId !== sessionId || !held) {
        throw new Error(
          "Conversation environment belongs to another guest or is awaiting authority recovery",
        );
      }
      held.authority.assertCurrent();
    },
    async recover(this: void, binding: SessionGuestBinding, environmentId: string) {
      try {
        await retain(binding, environmentId);
        return true;
      } catch (error) {
        if (error instanceof SessionGuestAccessRevokedError) {
          await options.retire(binding, environmentId);
        } else {
          options.warn("Guest environment authority recovery remains pending for " + environmentId);
        }
        return false;
      }
    },
  };
}
