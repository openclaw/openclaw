import { createMemo, Show } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import {
  resolveCloudProfileIconData,
  type CloudProfileIdentity,
} from "../cloud-profile-icon-data.ts";
import { Icon } from "./icon.tsx";
import { ProviderAsset } from "./provider-icon.tsx";

export function CloudProfileIcon(props: { profile?: CloudProfileIdentity; class?: string }) {
  const data = createMemo(() => resolveCloudProfileIconData(props.profile));
  return (
    <span class={["cloud-profile-icon", props.class]} aria-hidden="true">
      <Show when={data().providerId} fallback={<Icon name={data().iconName!} />}>
        {(providerId) => (
          <ProviderAsset
            icon={providerId()}
            assetPath={inferControlUiPublicAssetPath(`cloud-provider-icons/${providerId()}.svg`)}
            class="cloud-provider-icon"
          />
        )}
      </Show>
    </span>
  );
}
