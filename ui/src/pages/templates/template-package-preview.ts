import type { TemplateDraftReviewItem } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { bytesToBase64 } from "../../lib/bytes-base64.ts";
import type { TemplatePackagePreview } from "./creator-publication.ts";

/** Reads only the exact package coordinate or archived file selected by a review owner. */
export async function readTemplatePackagePreview(
  client: GatewayBrowserClient,
  files: readonly { path: string; content?: string }[],
  item: TemplateDraftReviewItem,
): Promise<TemplatePackagePreview | null> {
  if (!item.requirement) {
    return null;
  }
  const requirement = item.requirement;
  if (requirement.source === "bundled") {
    return {
      content:
        item.kind === "skill"
          ? files.find((file) => file.path === `${requirement.path}/SKILL.md`)?.content
          : undefined,
    };
  }
  const { ref, version } = requirement;
  let preview: TemplatePackagePreview;
  if (item.kind === "skill") {
    const result = await client.request<{
      skill?: { summary?: string | null } | null;
      card?: { status: "available"; content: string } | { status: "unavailable" };
    }>("skills.detail", { slug: ref, version });
    preview = {
      description: result.skill?.summary,
      content: result.card?.status === "available" ? result.card.content : undefined,
    };
  } else if (item.kind === "plugin") {
    // Catalog IDs are the Gateway's ch_ + base64url encoding of the validated package ref.
    const id =
      "ch_" +
      bytesToBase64(new TextEncoder().encode(ref))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/[=]+$/u, "");
    const result = await client.request<{
      plugin: { catalog: { summary?: string } };
      detail: {
        origin: string;
        packageName?: string;
        selectedRelease?: { version: string } | null;
        remoteError?: string;
      };
    }>("plugins.catalog.get", { id, version });
    preview =
      result.detail.origin === "clawhub" &&
      result.detail.packageName === ref &&
      result.detail.selectedRelease?.version === version &&
      !result.detail.remoteError
        ? { description: result.plugin.catalog.summary }
        : {};
  } else {
    return null;
  }

  return preview;
}
