import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { joinClawHubPluginCatalog } from "../../plugins/catalog-discovery.js";
import {
  registerClawHubCatalogIconUrls,
  resolveClawHubCatalogIconUrl,
} from "../../plugins/catalog-icon-registry.js";
import { listManagedPlugins } from "../../plugins/management-service.js";
import {
  CLAWHUB_RECOMMENDATION_LIMIT,
  type ClawHubRecommendation,
} from "../../shared/clawhub-recommendations.js";
import { buildWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import { resolveClawHubBaseUrl, resolveClawHubImageUrl } from "../clawhub-client.js";
import { fetchClawHubPluginCatalog } from "../clawhub-plugin-catalog.js";
import { searchClawHubSkills } from "../clawhub-skills.js";

const requestSchema = z
  .object({
    query: z.string().trim().min(1).max(160),
    kind: z.enum(["plugin", "skill"]).optional(),
  })
  .strict();

export async function resolveClawHubRecommendations(params: {
  request: unknown;
  config: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
}): Promise<{ cards: ClawHubRecommendation[]; text: string }> {
  const request = requestSchema.parse(params.request);
  const unavailable = {
    cards: [],
    text: "ClawHub recommendations are unavailable right now, so I could not verify a matching capability or its installation status. Please try again.",
  };
  let cards: ClawHubRecommendation[] = [];
  if (request.kind !== "skill") {
    const found = await Promise.all([
      fetchClawHubPluginCatalog({
        query: request.query,
        intent: "official",
        limit: CLAWHUB_RECOMMENDATION_LIMIT,
      }),
      listManagedPlugins({ config: params.config }),
    ]).catch(() => undefined);
    if (!found) {
      return unavailable;
    }
    const [remote, local] = found;
    registerClawHubCatalogIconUrls(remote.items.map((entry) => entry.iconUrl));
    cards = joinClawHubPluginCatalog({ remote: remote.items, local })
      .filter((entry) => entry.catalog.official)
      .slice(0, CLAWHUB_RECOMMENDATION_LIMIT)
      .map((entry) => {
        const iconUrl = entry.catalog.imageUrl
          ? resolveClawHubCatalogIconUrl(entry.catalog.imageUrl)
          : undefined;
        return {
          type: "clawhub",
          kind: "plugin",
          id: entry.id,
          name: truncateUtf16Safe(entry.catalog.name, 120),
          description: entry.catalog.summary
            ? truncateUtf16Safe(entry.catalog.summary, 240)
            : undefined,
          iconUrl,
          installed: entry.local.installed,
          official: true,
          pluginId: entry.local.pluginId,
        };
      });
  }
  if (request.kind !== "plugin" && cards.length === 0) {
    const remote = await searchClawHubSkills({ query: request.query, limit: 20 }).catch(
      () => undefined,
    );
    if (!remote) {
      return unavailable;
    }
    const official = remote
      .filter((entry) => entry.official === true && !entry.installOnly)
      .slice(0, CLAWHUB_RECOMMENDATION_LIMIT);
    if (official.length > 0 && !params.workspaceDir) {
      throw new Error("ClawHub skill recommendations require the current agent workspace.");
    }
    const local =
      params.workspaceDir && official.length > 0
        ? buildWorkspaceSkillStatus(params.workspaceDir, {
            config: params.config,
            agentId: params.agentId,
          }).skills
        : [];
    cards = official.map((entry) => {
      const iconUrl = resolveClawHubImageUrl(entry.icon);
      return {
        type: "clawhub",
        kind: "skill",
        registry: resolveClawHubBaseUrl(),
        id: entry.installRef,
        skillRef: entry.installRef,
        name: truncateUtf16Safe(entry.displayName, 120),
        description: entry.summary ? truncateUtf16Safe(entry.summary, 240) : undefined,
        iconUrl,
        installed: local.some((skill) => {
          const link = skill.clawhub;
          return (
            link?.valid === true &&
            !link.requestedReference &&
            link.registry === resolveClawHubBaseUrl() &&
            `@${link.ownerHandle}/${link.slug}` === entry.installRef
          );
        }),
        official: true,
      };
    });
    registerClawHubCatalogIconUrls(cards.map((card) => card.iconUrl));
  }
  return {
    cards,
    text:
      cards.length > 0
        ? cards
            .map(
              (card) => `${card.name}: ${card.installed ? "Installed" : "Available to install"}.`,
            )
            .join("\n")
        : `No official ClawHub ${request.kind ?? "plugin or skill"} match was returned for “${request.query}”. Try a more specific capability name.`,
  };
}
