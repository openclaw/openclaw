import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import { hasOperatorReadAccess } from "./operator-access.ts";

/** Identity proof completes sign-in; GitHub consent separately supplies personal API authority. */
export function startGitHubSignInConsent(
  context: Pick<ApplicationContext, "gateway" | "connectionBootstrap" | "lifecycleAbortSignal">,
): () => void {
  let lifetime: AbortController | undefined;
  let owner:
    | { client: ApplicationGatewaySnapshot["client"]; profileId: string; hello: object }
    | undefined;
  const retire = () => {
    lifetime?.abort();
    lifetime = undefined;
    owner = undefined;
  };
  const update = (snapshot: ApplicationGatewaySnapshot) => {
    const profileId = snapshot.selfUser?.id;
    if (
      snapshot.phase !== "connected" ||
      !snapshot.client ||
      !snapshot.hello ||
      !profileId ||
      !hasOperatorReadAccess(snapshot.hello.auth ?? null)
    ) {
      retire();
      return;
    }
    if (
      owner?.client === snapshot.client &&
      owner.profileId === profileId &&
      owner.hello === snapshot.hello
    ) {
      return;
    }
    retire();
    const selected = { client: snapshot.client, profileId, hello: snapshot.hello };
    owner = selected;
    const controller = new AbortController();
    lifetime = controller;
    const signal = context.lifecycleAbortSignal
      ? AbortSignal.any([controller.signal, context.lifecycleAbortSignal])
      : controller.signal;
    void context.connectionBootstrap.run(
      selected,
      async () => {
        const profile = await context.gateway.loadSelfProfile();
        if (
          signal.aborted ||
          owner !== selected ||
          profile?.id !== profileId ||
          !profile.githubIdentity
        ) {
          return;
        }
        const { completeGitHubSignInConsent } =
          await import("../features/github-connections/github-signin-consent.ts");
        if (!signal.aborted && owner === selected) {
          // The dialog owns its lifetime; it must not occupy a bootstrap queue slot during consent.
          void completeGitHubSignInConsent(selected.client, profileId, signal);
        }
      },
      { background: true },
    );
  };
  const stop = context.gateway.subscribe(update);
  update(context.gateway.snapshot);
  return () => {
    stop();
    retire();
  };
}
