import type {
  ControlUiComponentHandle,
  ControlUiAgentAvatarProps,
} from "../../../src/plugin-sdk/control-ui-components.js";
import type { AgentIdentityResult, AgentsListResult } from "../api/types.ts";
import { bootstrapApplication, type ApplicationRuntime } from "../app/bootstrap.ts";
import type { AgentAvatarElement } from "../components/solid/agent-avatar.tsx";
import { createControlUiComponents } from "../plugins/control-ui-components.ts";
import type { ControlUiMockGateway } from "./control-ui-e2e-contract.ts";
import type {
  ProjectionFixtureFacts,
  SdkAvatarFamily,
} from "./control-ui-projection-fixture-contract.ts";
import { createProjectionResourceProbe } from "./control-ui-projection-resource-probe.ts";

type Mounted = {
  factory: number;
  host: HTMLElement;
  handle: ControlUiComponentHandle<ControlUiAgentAvatarProps>;
};
type Group = {
  label: string;
  count: number;
  runtime: ApplicationRuntime;
  root: HTMLElement;
  roster: AgentsListResult;
  agentId: string;
  factories: AbortController[];
  mounted: Mounted[];
  publications?: { agents: number; identities: number };
  stopSentinels: (() => void)[];
};

const settle = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
async function waitFor(check: () => boolean, label: string) {
  const until = performance.now() + 15_000;
  while (!check()) {
    if (performance.now() > until) {
      throw new Error(`SDK fixture setup timed out: ${label}`);
    }
    await settle();
  }
}
function mockGateway(): ControlUiMockGateway {
  const value: unknown = Reflect.get(window, "openclawControlUiE2eGateway");
  if (!value) {
    throw new Error("SDK fixture requires the existing synthetic Gateway");
  }
  return value as ControlUiMockGateway;
}

/** Real SDK factories and native application owners; this module is benchmark-only. */
export function createSdkAvatarFixture(family: SdkAvatarFamily, instrumented: boolean) {
  const groups: Group[] = [];
  const probe = instrumented ? createProjectionResourceProbe() : undefined;
  const errors: string[] = [];
  const facts: ProjectionFixtureFacts & {
    sdk: {
      methods: { phase: string; counts: ReturnType<NonNullable<typeof probe>["methodSnapshot"]> }[];
      publications: { phase: string; application: string; agents: number; identities: number }[];
      synchronousInvalidationReads: number[];
    };
  } = {
    family,
    instrumented,
    mounted: [],
    checkpoints: [],
    sdk: {
      methods: [],
      publications: [],
      synchronousInvalidationReads: [],
    },
  };
  const rows = (group: Group) =>
    group.root.querySelectorAll<AgentAvatarElement>("openclaw-agent-avatar");
  const snapshot = (phase: string) => {
    if (!probe) {
      return;
    }
    facts.checkpoints.push({ phase, counts: probe.snapshot() });
    facts.sdk.methods.push({ phase, counts: probe.methodSnapshot() });
    for (const group of groups) {
      if (group.publications) {
        facts.sdk.publications.push({ phase, application: group.label, ...group.publications });
      }
    }
  };
  const assertRows = (group: Group, count: number) => {
    if (rows(group).length !== count) {
      throw new Error(
        `SDK ${group.label}: expected ${count} mounted avatars, got ${rows(group).length}`,
      );
    }
    if (errors.length) {
      throw new Error(errors.join("\n"));
    }
  };
  const content = (group: Group) =>
    JSON.stringify(
      [...rows(group)].map((host) => ({
        id: host.option.value,
        name: host.option.agent?.name,
        label: host.option.label,
        identity: host.identity?.name,
        text: host.textContent,
      })),
    );
  const identity = (group: Group, revision: number): AgentIdentityResult => ({
    agentId: group.agentId,
    name: `${group.label} identity ${revision}`,
    avatarStatus: "none",
  });
  const assertPublication = (group: Group, revision: number) => {
    const expected =
      family === "sdk-avatars"
        ? `${group.label} publication ${revision}`
        : `${group.label} identity ${revision}`;
    if (
      [...rows(group)].some(
        (host) =>
          (family === "sdk-avatars" ? host.option.agent?.name : host.identity?.name) !== expected,
      )
    ) {
      throw new Error(`SDK ${group.label}: retained avatars did not display ${expected}`);
    }
  };
  async function publishAgents(group: Group, revision: number) {
    mockGateway().setMethodResponse("agents.list", {
      ...group.roster,
      agents: group.roster.agents.map((agent) => ({
        ...agent,
        name: `${group.label} publication ${revision}`,
      })),
    });
    await group.runtime.context.agents.refreshList();
    await settle();
  }
  async function publishIdentity(group: Group, revision: number) {
    const owner = group.runtime.context.agentIdentity;
    mockGateway().setMethodResponse("agent.identity.get", identity(group, revision));
    const before = probe?.methodSnapshot();
    owner.invalidate([group.agentId]);
    if (probe) {
      const after = probe.methodSnapshot();
      facts.sdk.synchronousInvalidationReads.push(
        (after[`${group.label}.identity.get`]?.calls ?? 0) -
          (before?.[`${group.label}.identity.get`]?.calls ?? 0),
      );
      const hydrationCalls =
        (after[`${group.label}.identity.ensure`]?.calls ?? 0) -
        (before?.[`${group.label}.identity.ensure`]?.calls ?? 0);
      if (hydrationCalls !== rows(group).length) {
        throw new Error(
          `SDK ${group.label}: invalidation did not synchronously hydrate every avatar`,
        );
      }
    }
    // Observe the SDK's request; starting one here could repair broken hydration.
    await waitFor(
      () => owner.get(group.agentId)?.name === `${group.label} identity ${revision}`,
      `${group.label} SDK-driven identity publication ${revision}`,
    );
    await settle();
  }
  return {
    async setup() {
      for (const [label, count] of [
        ["A", 120],
        ["B", 40],
      ] as const) {
        const runtime = bootstrapApplication();
        const root = document.createElement("section");
        root.dataset.projectionApplication = label;
        root.style.cssText =
          "display:grid;gap:2px;grid-template-columns:repeat(10,minmax(0,1fr));font-size:10px";
        const group: Group = {
          label,
          count,
          runtime,
          root,
          roster: { defaultId: "", mainKey: "main", scope: "per-sender", agents: [] },
          agentId: "",
          factories: [],
          mounted: [],
          stopSentinels: [],
        };
        groups.push(group);
        document.body.append(root);
        await runtime.start();
        await runtime.context.agents.refreshList();
        const roster = runtime.context.agents.state.agentsList;
        if (!roster?.agents.length || runtime.context.gateway.snapshot.phase !== "connected") {
          throw new Error(`SDK ${label}: fresh native runtime unavailable`);
        }
        group.roster = roster;
        group.agentId = roster.defaultId || roster.agents[0]!.id;
        mockGateway().setMethodResponse("agent.identity.get", identity(group, 0));
        runtime.context.agentIdentity.invalidate([group.agentId]);
        if (probe) {
          group.publications = { agents: 0, identities: 0 };
          // Sentinels count real owner publications but precede the observed registration window.
          group.stopSentinels.push(
            runtime.context.agents.subscribe(() => group.publications!.agents++),
            runtime.context.agentIdentity.subscribe(() => group.publications!.identities++),
          );
          probe.observeSource(runtime.context.agents, `${label}.agents`);
          probe.observeSource(runtime.context.agentIdentity, `${label}.agentIdentity`);
          probe.observeMethod(runtime.context.agentIdentity, "get", `${label}.identity.get`);
          probe.observeMethod(runtime.context.agentIdentity, "ensure", `${label}.identity.ensure`);
        }
        snapshot(`${label}:before-mount`);
        for (let factory = 0; factory < 2; factory++) {
          const lifetime = new AbortController();
          group.factories.push(lifetime);
          const components = createControlUiComponents({
            current: () => runtime.context,
            signal: lifetime.signal,
            onError: (error) => errors.push(String(error)),
          });
          for (let index = factory; index < count; index += 2) {
            const host = document.createElement("div");
            host.dataset.sdkFactory = String(factory);
            root.append(host);
            group.mounted.push({
              factory,
              host,
              handle: components.mountAgentAvatar(host, {
                agentId: index % 4 < 2 ? group.agentId : "",
                label: `${label} SDK avatar ${index}`,
              }),
            });
          }
        }
        await waitFor(() => rows(group).length === count, `${label} native hosts`);
        await waitFor(
          () => runtime.context.agentIdentity.get(group.agentId)?.name === `${label} identity 0`,
          `${label} SDK-driven initial identity hydration`,
        );
        await Promise.all([...rows(group)].map((host) => host.updateComplete));
        await settle();
        assertRows(group, count);
        if (
          [...rows(group)].some(
            (host) =>
              host.identity?.name !== `${label} identity 0` || host.option.value !== group.agentId,
          )
        ) {
          throw new Error(`SDK ${label}: initial/default identity binding mismatch`);
        }
        facts.mounted.push({ application: label, expected: count, actual: rows(group).length });
        snapshot(`${label}:mounted`);
      }
      if (
        groups[0]!.runtime.context.agents === groups[1]!.runtime.context.agents ||
        groups[0]!.runtime.context.agentIdentity === groups[1]!.runtime.context.agentIdentity
      ) {
        throw new Error("SDK applications unexpectedly share native owners");
      }
      snapshot("warmed");
      return structuredClone(facts);
    },
    async run() {
      const a = groups[0]!;
      const b = groups[1]!;
      const other = content(b);
      const before = probe?.snapshot();
      const publications = a.publications && { ...a.publications };
      if (family === "sdk-avatars") {
        for (let revision = 1; revision <= 10; revision++) {
          await publishAgents(a, revision);
        }
        if ([...rows(a)].some((host) => host.option.agent?.name !== "A publication 10")) {
          throw new Error("SDK roster publication failed to update every binding");
        }
      } else {
        for (let revision = 1; revision <= 10; revision++) {
          await publishIdentity(a, revision);
        }
        if ([...rows(a)].some((host) => host.identity?.name !== "A identity 10")) {
          throw new Error("SDK identity publications failed to update every binding");
        }
      }
      if (content(b) !== other) {
        throw new Error("Publishing SDK application A changed B bindings");
      }
      if (probe && before) {
        const after = probe.snapshot();
        for (const [name, source] of Object.entries(after.sources)) {
          if (name.startsWith("B.") && source.callbacks !== before.sources[name]?.callbacks) {
            throw new Error(`Publishing A delivered B native callback: ${name}`);
          }
        }
        const measured =
          family === "sdk-avatars"
            ? a.publications!.agents - publications!.agents
            : a.publications!.identities - publications!.identities;
        if (measured !== 20) {
          throw new Error(`Expected 20 actual native SDK publications, got ${measured}`);
        }
      }
      assertRows(a, 120);
      assertRows(b, 40);
      snapshot("published-A");
      return structuredClone(facts);
    },
    async finish() {
      const a = groups[0]!;
      const b = groups[1]!;
      for (const entry of a.mounted.filter((mounted) => mounted.factory === 0)) {
        entry.handle.dispose();
      }
      await settle();
      assertRows(a, 60);
      assertRows(b, 40);
      snapshot("retired-A-factory-0");
      if (family === "sdk-avatars") {
        await publishAgents(a, 21);
      } else {
        await publishIdentity(a, 11);
      }
      assertPublication(a, family === "sdk-avatars" ? 21 : 11);
      snapshot("published-A-factory-1");
      const retained = a.mounted.find((entry) => entry.factory === 1)!;
      retained.handle.update({ agentId: a.agentId, label: "A retained SDK update" });
      await settle();
      const updated = retained.host.querySelector<AgentAvatarElement>("openclaw-agent-avatar");
      if (updated?.option.label !== "A retained SDK update") {
        throw new Error("SDK retained handle.update lost its latest props");
      }
      snapshot("updated-A-factory-1");
      a.factories[1]!.abort();
      await settle();
      assertRows(a, 0);
      assertRows(b, 40);
      snapshot("retired-A");
      if (family === "sdk-avatars") {
        await publishAgents(b, 22);
      } else {
        await publishIdentity(b, 12);
      }
      assertPublication(b, family === "sdk-avatars" ? 22 : 12);
      snapshot("published-B");
      for (const lifetime of b.factories) {
        lifetime.abort();
      }
      await settle();
      assertRows(b, 0);
      snapshot("retired-all");
      if (probe && Object.values(probe.snapshot().sources).some((source) => source.active !== 0)) {
        throw new Error("SDK native subscriptions outlived all mounts");
      }
      return structuredClone(facts);
    },
    dispose() {
      for (const group of groups.toReversed()) {
        for (const lifetime of group.factories) {
          lifetime.abort();
        }
        for (const entry of group.mounted) {
          entry.handle.dispose();
        }
        for (const stop of group.stopSentinels) {
          stop();
        }
        group.runtime.stop();
        group.root.remove();
      }
      probe?.dispose();
    },
  };
}
