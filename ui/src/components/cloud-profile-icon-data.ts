export type CloudProfileIdentity = { providerId: string; providerDisplayId?: string };

// Cloud backends are a separate identity domain: Google Cloud is not Gemini,
// and AWS is not Bedrock. Map lookup also keeps prototype keys on the fallback.
const CLOUD_PROVIDERS = new Map<string, { label: string; brand?: string }>([
  ["aws", { label: "AWS", brand: "aws" }],
  ["azure", { label: "Azure", brand: "azure" }],
  ["daytona", { label: "Daytona", brand: "daytona" }],
  ["gcp", { label: "Google Cloud", brand: "gcp" }],
  ["hetzner", { label: "Hetzner", brand: "hetzner" }],
  ["machine0", { label: "Machine0" }],
]);
const CLOUD_ALIASES = new Map([
  ["google", "gcp"],
  ["google-cloud", "gcp"],
  ["docker", "local-container"],
  ["local-docker", "local-container"],
  ["podman", "local-container"],
  ["local-podman", "local-container"],
]);

function cloudProfileBackendId(profile?: CloudProfileIdentity): string {
  const raw = (profile?.providerDisplayId ?? profile?.providerId ?? "").trim().toLowerCase();
  return CLOUD_ALIASES.get(raw) ?? raw;
}

/** Known cloud services precede local/custom infrastructure, alphabetically within each group. */
export function compareCloudProfiles(
  left: CloudProfileIdentity & { id: string },
  right: CloudProfileIdentity & { id: string },
): number {
  // Backend identity, not an editable profile name or the availability of a logo.
  return (
    Number(CLOUD_PROVIDERS.has(cloudProfileBackendId(right))) -
      Number(CLOUD_PROVIDERS.has(cloudProfileBackendId(left))) || left.id.localeCompare(right.id)
  );
}

/** Cloud identity is distinct from model-provider identity (Google Cloud versus Gemini). */
type CloudProfileIconData = {
  label: string;
} & (
  | { providerId: string; iconName?: never }
  | { providerId?: never; iconName: "server" | "box" | "cloud" }
);

export function resolveCloudProfileIconData(profile?: CloudProfileIdentity): CloudProfileIconData {
  const id = cloudProfileBackendId(profile);
  const brand = CLOUD_PROVIDERS.get(id);
  const label =
    brand?.label ?? (profile?.providerDisplayId ?? profile?.providerId ?? "").trim().toLowerCase();
  return brand?.brand
    ? {
        label,
        providerId: brand.brand,
      }
    : {
        label,
        iconName:
          id === "machine0" || id === "incus"
            ? "server"
            : id === "local-container"
              ? "box"
              : "cloud",
      };
}
