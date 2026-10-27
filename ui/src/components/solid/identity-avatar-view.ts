import { createMemo, type Accessor } from "solid-js";
import {
  readAvatarGatewayContext,
  registerAvatarGatewayReset,
} from "../../lib/identity-avatar-context.ts";
import { resolveIdentityAvatarView } from "../../lib/identity-avatar-view.ts";
import type { IdentityAvatarInput } from "../../lib/identity-avatar.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { sharedProfileDirectoryProjection } from "../../lib/reactive/shared-application-projections.ts";

// The Gateway context is document-wide; the last observed avatar releases its listener.
const avatarGatewayContext = projectSource(null, {
  read: readAvatarGatewayContext,
  subscribe: (_source, notify) => registerAvatarGatewayReset(notify),
  equality: "revision",
});

export function useIdentityAvatarView(identity: Accessor<IdentityAvatarInput>) {
  const gateway = useAvatarGatewayContext();
  const application = useOptionalApplication();
  const directory = application
    ? sharedProfileDirectoryProjection(profileDirectory(application.gateway))
    : undefined;
  return createMemo(() => {
    gateway();
    const input = identity();
    return resolveIdentityAvatarView(
      input.identity?.type === "profile" && !input.profileAvatarUrl?.trim() && directory
        ? directory.read().avatarIdentity(input)
        : input,
    );
  });
}

/** Reset notification invalidates the projection; reads follow the owner's synchronous publication. */
export function useAvatarGatewayContext() {
  return avatarGatewayContext.read;
}
