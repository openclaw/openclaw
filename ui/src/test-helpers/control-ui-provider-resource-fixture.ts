import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderDocument,
} from "../../../src/shared/control-ui-link-reader.js";
import type { LinkReaderHovercardProvider } from "../components/link-reader-hovercard.types.ts";
import {
  instanceAssert as assert,
  instanceGateway,
  instanceSettle as settle,
  instanceWait as wait,
  type InstanceContext,
} from "./control-ui-instance-resource-fixture.ts";
const href = "https://forge.example/items/1";
const reader: ControlUiLinkReaderDescriptor = {
  pluginId: "forge",
  id: "items",
  label: "Synthetic Forge",
  icon: "externalLink",
  linkReader: {
    hosts: ["forge.example"],
    pathPattern: "^/items/[1-9][0-9]*$",
    detailMethod: "forge.detail",
    previewMethod: "forge.preview",
  },
};
const documentResult = (
  label: string,
  tone: "positive" | "accent" = "positive",
): ControlUiLinkReaderDocument => ({
  url: href,
  title: `${label} synthetic item`,
  badge: { label, tone },
  body: "Synthetic benchmark content. No account or production data.",
  comments: [],
});

export async function createInstanceConsumers(
  context: InstanceContext,
  family: "link-providers" | "link-metadata",
) {
  await Promise.all([
    import("../components/link-reader-hovercard.ts"),
    import("../components/link-reader-panel.tsx"),
  ]);
  const { resolveLinkReaderTarget } = await import("../components/link-reader-target.ts");
  const { LINK_READER_METADATA_REQUEST_EVENT } =
    await import("../components/link-reader-response.ts");
  const { LINK_READER_PANEL_TOGGLE_EVENT } = await import("../components/panel-toggle-contract.ts");
  const rows: {
    provider: LinkReaderHovercardProvider;
    anchor: HTMLAnchorElement;
    label: string;
  }[] = [];
  const panels: HTMLElementTagNameMap["openclaw-link-reader-panel"][] = [];
  const openPanel = (panel: (typeof panels)[number]) =>
    panel.handleToggleRequest(
      new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
        detail: { url: href, open: true },
        cancelable: true,
      }),
    );
  const replays = () => window.dispatchEvent(new Event(LINK_READER_METADATA_REQUEST_EVENT));
  const tone = (row: (typeof rows)[number]) => row.anchor.dataset.linkReaderTone;
  return {
    async setup() {
      for (const [label, count] of [
        ["A", 100],
        ["B", 30],
      ] as const) {
        instanceGateway().setMethodResponse("forge.detail", documentResult(label));
        const group = await context.group(label, count);
        const client = group.runtime.context.gateway.snapshot.client;
        assert(client, "Provider fixture has no admitted native client");
        const panel = document.createElement("openclaw-link-reader-panel");
        Object.assign(panel, {
          client,
          available: true,
          readers: [reader],
          embedded: true,
          presented: true,
          suppressed: false,
          agentId: "main",
          sessionKey: `agent:main:provider-${label}`,
        });
        group.root.append(panel);
        panels.push(panel);
        await panel.updateComplete;
        openPanel(panel);
        await wait(
          () => panel.textContent?.includes(`${label} synthetic item`),
          "Real panel did not accept its synthetic document",
        );
        context.probe?.sources.observeSource(group.runtime.context.gateway, `${label}.gateway`);
        context.capture(`${label}:before-consumers`);
        for (let index = 0; index < count; index++) {
          const provider = document.createElement("openclaw-link-reader-hovercard-provider");
          Object.assign(provider, {
            readers: [reader],
            client,
            agentId: "main",
            sessionKey: `agent:main:provider-${label}`,
          });
          const anchor = document.createElement("a");
          anchor.href = href;
          anchor.className = "markdown-github-item";
          anchor.textContent = `${label} item ${index}`;
          provider.append(anchor);
          group.root.append(provider);
          rows.push({ provider, anchor, label });
        }
        await settle();
        await wait(
          () => rows.filter((row) => row.label === label).every((row) => tone(row) === "positive"),
          "Actual panel metadata replay did not decorate matching providers",
        );
        context.recordMounted(
          group,
          rows.filter((row) => row.label === label && row.provider.isConnected).length,
        );
        context.capture(`${label}:providers-mounted`);
      }
      assert(
        context.groups[0]!.runtime.context.gateway !== context.groups[1]!.runtime.context.gateway,
        "Provider applications share a native Gateway",
      );
      assert(
        context.groups[0]!.runtime.context.gateway.snapshot.client !==
          context.groups[1]!.runtime.context.gateway.snapshot.client,
        "Provider scopes require independent native clients",
      );
      // The target text is identical but native client and session identities differ.
      assert(
        rows.every((row) => row.anchor.getAttribute("aria-description") === row.label),
        "Panel metadata crossed an application/session scope",
      );
      context.capture("warmed");
      return context.result();
    },
    async run() {
      const beforeNodes = rows.flatMap((row) => [row.provider, row.anchor]);
      const bText = rows
        .filter((row) => row.label === "B")
        .map((row) => row.anchor.outerHTML)
        .join("");
      for (let revision = 0; revision < 20; revision++) {
        if (family === "link-metadata") {
          replays();
        } else {
          for (const row of rows.filter((candidate) => candidate.label === "A")) {
            const marker = document.createElement("span");
            marker.textContent = `A item revision ${revision}`;
            row.anchor.replaceChildren(marker);
          }
        }
        await settle();
      }
      assert(
        beforeNodes.every((node) => node.isConnected),
        "Provider update replaced a retained provider/anchor",
      );
      assert(
        rows
          .filter((row) => row.label === "B")
          .map((row) => row.anchor.outerHTML)
          .join("") === bText,
        "A publication changed B's native scoped metadata",
      );
      assert(
        rows.every((row) => tone(row) === "positive"),
        "Provider update lost accepted inline metadata",
      );
      context.capture(
        family === "link-metadata" ? "20-real-panel-replays" : "20-provider-mutation-batches",
      );
      context.facts.assertions.push(
        "100 A / 30 B real providers retain DOM identity and exact-client/session panel metadata across 20 native batches",
      );
      return context.result();
    },
    async finish() {
      const first = rows[0]!;
      const target = resolveLinkReaderTarget(href, [reader]);
      assert(target, "Synthetic plugin target not admitted by the real resolver");
      instanceGateway().setMethodResponse("forge.preview", documentResult("A"));
      context.capture("before-plugin-intent");
      first.provider.activateFromBootstrap(first.anchor, target, "focus", 0);
      await wait(
        () => document.querySelector(".link-reader-hovercard") !== null,
        "Real plugin preview did not reveal after intent",
      );
      context.capture("plugin-active-anchor");
      first.anchor.href = "https://example.test/retired";
      await wait(
        () => document.querySelector(".link-reader-hovercard") === null,
        "Retargeting did not retire active plugin anchor",
      );
      assert(
        !first.anchor.hasAttribute("aria-description"),
        "Retargeted anchor retained stale metadata",
      );
      first.anchor.href = href;
      await settle();
      replays();
      await settle();
      assert(
        tone(first) === "positive",
        "Retained provider did not recover after an admitted target returned",
      );
      const oldScope = panels[0]!;
      instanceGateway().setMethodResponse("forge.detail", documentResult("Other agent", "accent"));
      oldScope.agentId = "other-agent";
      await oldScope.updateComplete;
      openPanel(oldScope);
      await wait(
        () => oldScope.textContent?.includes("Other agent synthetic item"),
        "Real panel scope rebind did not reload",
      );
      replays();
      await settle();
      assert(
        rows.every((row) => tone(row) === "positive"),
        "Rebound agent scope overwrote original providers",
      );
      instanceGateway().setMethodResponse(
        "forge.detail",
        documentResult("Other session", "accent"),
      );
      oldScope.agentId = "main";
      oldScope.sessionKey = "agent:main:provider-other";
      await oldScope.updateComplete;
      openPanel(oldScope);
      await wait(
        () => oldScope.textContent?.includes("Other session synthetic item"),
        "Real panel session rebind did not reload",
      );
      replays();
      await settle();
      assert(
        rows.every((row) => tone(row) === "positive"),
        "Rebound session scope overwrote original providers",
      );
      const otherClient = panels[1]!;
      instanceGateway().setMethodResponse("forge.detail", documentResult("Other client", "accent"));
      otherClient.sessionKey = "agent:main:provider-A";
      await otherClient.updateComplete;
      openPanel(otherClient);
      await wait(
        () => otherClient.textContent?.includes("Other client synthetic item"),
        "Real panel client-scope fixture did not reload",
      );
      replays();
      await settle();
      assert(
        rows.every((row) => tone(row) === "positive"),
        "A different native client overwrote matching agent/session metadata",
      );
      context.capture("agent-session-client-scope-isolation");
      for (const row of rows.filter((candidate) => candidate.label === "A").slice(1)) {
        row.provider.remove();
      }
      await settle();
      replays();
      await settle();
      assert(
        first.provider.isConnected &&
          rows.filter((row) => row.label === "B").every((row) => tone(row) === "positive"),
        "Independent provider cleanup retired a remaining scope",
      );
      context.capture("one-A-and-all-B-remain");
      for (const row of rows) {
        row.provider.remove();
      }
      await settle();
      context.capture("providers-retired");
      const final = context.facts.nativeCheckpoints.at(-1);
      if (final) {
        assert(
          (final.events["window.openclaw:link-reader-metadata-updated"]?.active ?? 0) === 0,
          "Provider metadata listener survived its last consumer",
        );
      }
      for (const panel of panels) {
        panel.remove();
      }
      await settle();
      context.capture("retired-all");
      context.facts.assertions.push(
        "Plugin intent and href retirement; real panel independent agent/session/client isolation; independent provider cleanup and metadata-listener teardown",
      );
      return context.result();
    },
  };
}
