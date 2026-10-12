import { createMemo, type Accessor } from "solid-js";
import type { IdentityAvatarInput } from "../../lib/identity-avatar.ts";
import { profileDirectory } from "../../lib/profile-directory.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { resolveIdentityAvatarView } from "../identity-avatar-view.ts";
import { useIdentityApplication } from "./identity-application.ts";

export function useIdentityAvatarView(identity: Accessor<IdentityAvatarInput>) {
  const application = useIdentityApplication();
  const directory = application
    ? projectSource(profileDirectory(application.gateway), {
        read: (source) => source,
        subscribe: (source, notify) => source.subscribe(notify),
        equality: "revision",
      })
    : undefined;
  return createMemo(() => {
    const input = identity();
    return resolveIdentityAvatarView(
      input.identity?.type === "profile" && directory
        ? directory.read().avatarIdentity(input)
        : input,
    );
  });
}
