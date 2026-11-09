import { Show } from "solid-js";
import { IdentityAvatarImage, createIdentityAvatarPresentation } from "./identity-avatar-image.tsx";
import { useIdentityAvatarView } from "./identity-avatar-view.ts";

/** Shared, noninteractive presentation for sent references and composer widgets. */
export function PersonReferenceLabel(props: {
  profileId: string;
  label: string;
  avatarUrl?: string;
  literalPrefix?: boolean;
}) {
  const avatar = useIdentityAvatarView(() => ({
    id: props.profileId,
    identity: { type: "profile", id: props.profileId },
    name: props.label.replace(/^@/u, ""),
    profileAvatarUrl: props.avatarUrl,
  }));
  const presentation = createIdentityAvatarPresentation(avatar);
  return (
    <>
      <span
        data-avatar-state={presentation.state()}
        class={["markdown-person-reference__avatar", presentation.classes()]}
        aria-hidden="true"
        data-initials={avatar().fallback.initials}
      >
        <Show when={Boolean(avatar().imageUrl)}>
          <IdentityAvatarImage
            view={avatar()}
            onStateChange={presentation.onStateChange}
            ariaHidden={true}
          />
        </Show>
      </span>
      {props.label.startsWith("@") ? (
        <>
          <span class="markdown-person-reference__prefix" aria-hidden="true">
            {props.literalPrefix ? (
              <span class="markdown-person-reference__literal-prefix">@</span>
            ) : (
              "@"
            )}
          </span>
          {props.label.slice(1)}
        </>
      ) : (
        props.label
      )}
    </>
  );
}
