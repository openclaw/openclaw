import type { TemplateDraftReviewItem } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { createMemo, For } from "solid-js";
import { registerTemplateCreatorEnglish } from "../../i18n/locales/en-template-creator.ts";
import { registerTemplatesEnglish } from "../../i18n/locales/en-templates.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { TemplatePackagePreview } from "../templates/creator-publication.ts";
import { TemplateReviewCard, type TemplateReviewData } from "../templates/template-review-card.tsx";
import { templateImportFacts } from "./template-import-facts.ts";
import { TemplatePackageConsent, templatePackageConsents } from "./template-package-consent.tsx";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";

registerEnglishCatalog(registerTemplatesEnglish);
registerEnglishCatalog(registerTemplateCreatorEnglish);

/** The install owner supplies reviewed facts; the shared card owns only navigation. */
export function TemplateImportReview(props: {
  plan: TemplateAddReviewPlan;
  footer?: JSX.Element;
  readPackagePreview: (item: TemplateDraftReviewItem) => Promise<TemplatePackagePreview | null>;
}) {
  const consents = createMemo(() => templatePackageConsents(props.plan));
  const review = createMemo<TemplateReviewData>(() => {
    const facts = templateImportFacts(props.plan);
    const items: TemplateDraftReviewItem[] = [
      ...facts.skills.map((skill): TemplateDraftReviewItem => ({
        id: "skill:" + (skill.source === "bundled" ? skill.path : skill.ref),
        kind: "skill",
        label: skill.source === "bundled" ? skill.name : skill.ref,
        detail:
          skill.source === "bundled" ? t("templatesCatalog.dependencyBundled") : skill.version,
        included: true,
        requirement: skill,
      })),
      ...props.plan.pluginReviews.map((plugin): TemplateDraftReviewItem => ({
        id: plugin.actionId,
        kind: "plugin",
        label: plugin.pluginId,
        detail:
          plugin.source === "bundled" ? t("templatesCatalog.dependencyBundled") : plugin.version,
        included: true,
        requirement: plugin,
      })),
      ...facts.mcpServers.map((server): TemplateDraftReviewItem => ({
        id: "mcp:" + server.id,
        kind: "mcp",
        label: server.id,
        detail: JSON.stringify({
          transport: server.proposed?.transport,
          command: server.proposed?.command,
          args: server.proposed?.arguments,
          env:
            server.proposed?.environment &&
            Object.fromEntries(
              server.proposed.environment.map(({ name, sourceName }) => [
                name,
                "${" + sourceName + "}",
              ]),
            ),
          url: server.proposed?.url,
          urlDigest: server.proposed?.urlDigest,
          queryParameterNames: server.proposed?.queryParameterNames,
          auth: server.proposed?.authentication,
          toolFilter: server.proposed?.toolFilter,
          timeout: server.proposed?.timeout,
          connectTimeout: server.proposed?.connectTimeout,
        }),
        included: true,
      })),
      ...facts.schedules.flatMap((job): TemplateDraftReviewItem[] =>
        job.proposed
          ? [
              {
                id: "automation:" + job.id,
                kind: "automation",
                label: job.name,
                detail: JSON.stringify(job.proposed),
                included: true,
                ...("cron" in job.proposed.schedule
                  ? {
                      automation: {
                        message: job.proposed.message,
                        schedule: job.proposed.schedule,
                        session: job.proposed.session,
                        enabled: job.proposed.enabled,
                      },
                    }
                  : {}),
              },
            ]
          : [],
      ),
    ];
    return {
      displayName: facts.name,
      description: facts.description,
      files: props.plan.reviewFiles,
      items,
    };
  });
  const byline = () => {
    const source = props.plan.manifestDisclosure?.source;
    return source
      ? source.packageName +
          " · " +
          t("templatesCatalog.importVersion", { version: source.version })
      : undefined;
  };
  return (
    <TemplateReviewCard
      review={review()}
      byline={byline()}
      readPackagePreview={props.readPackagePreview}
      footer={props.footer}
      itemDetails={(item) => (
        <For
          each={consents().filter(
            (consent) =>
              consent.kind === item.kind &&
              (item.kind === "plugin"
                ? consent.actionId === item.id
                : item.requirement &&
                  consent.packageRef ===
                    (item.requirement.source === "bundled"
                      ? item.requirement.path
                      : item.requirement.ref)),
          )}
        >
          {(consent) => <TemplatePackageConsent review={consent} />}
        </For>
      )}
    />
  );
}
