/** Native browser callback document. The Gateway RPC owns code exchange and authority. */
export const GITLAB_OAUTH_CALLBACK_PATH = "/oauth/gitlab/callback";

export function parseGitLabOAuthCallback(
  redirectUri: string,
  callbackUrl: string,
): {
  code: string;
  state: string;
} {
  try {
    const callback = new URL(callbackUrl);
    const redirect = new URL(redirectUri);
    const codes = callback.searchParams.getAll("code");
    const states = callback.searchParams.getAll("state");
    if (
      callback.origin !== redirect.origin ||
      callback.pathname !== redirect.pathname ||
      callback.hash ||
      callback.username ||
      callback.password ||
      codes.length !== 1 ||
      states.length !== 1 ||
      !codes[0] ||
      !states[0] ||
      [...callback.searchParams.keys()].some((key) => key !== "code" && key !== "state")
    ) {
      throw new Error("invalid");
    }
    return { code: codes[0], state: states[0] };
  } catch {
    throw new Error("GitLab callback is invalid; restart connection.");
  }
}

/** Presentation routing hint only; never proof of the initiator, target or state claim. */
export function managedGitLabCallbackRequestId(callbackUrl: string): string | null {
  try {
    const states = new URL(callbackUrl).searchParams.getAll("state");
    if (states.length !== 1) {
      return null;
    }
    return (
      /^gitlab-managed\.(gitlab-setup-[a-f0-9]{32})\.[A-Za-z0-9_-]{43}$/u.exec(states[0]!)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}
