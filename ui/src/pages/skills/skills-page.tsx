import {
  createDeferred,
  createEffect,
  createMemo,
  createSignal,
  createStore,
  onSettled,
  Show,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import {
  hasOperatorAdminAccess,
  hasOperatorReadAccess,
  hasOperatorWriteAccess,
} from "../../app/operator-access.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPageRequest, type PageReadResult } from "../../lib/page-request.ts";
import { projectApplicationConfig } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { searchClawHub } from "../../lib/skills/clawhub-search.ts";
import {
  closeClawHubDetail,
  installFromClawHub,
  installSkill,
  loadClawHubDetail,
  loadClawHubSecurityVerdicts,
  loadSkillCard,
  loadSkills,
  refreshSkills,
  retireSkillsReads,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
  type SkillsState,
} from "../../lib/skills/index.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../plugins/plugin-icon-owner.ts";
import { PluginsHubHeader } from "../plugins/plugins-hub-header.tsx";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import { createSkillLibrary } from "./library-state.ts";
import { SkillLibrary, SkillLibraryDialogs, SkillLibraryFeedback } from "./library-view.tsx";
import { createSkillsMutationPresentation } from "./mutation-presentation.ts";
import { createSkillsData } from "./skills-page-state.ts";
import type {
  ClawHubDetailReceipt,
  SkillDetailTab,
  SkillsPageProps,
  SkillsPresentation,
  SkillsRouteData,
} from "./view-types.ts";
import { Skills } from "./view.tsx";

export function createSkillsRenderer(surface: "discovery" | "settings") {
  return (props: SolidRouteProps<SkillsRouteData>) => (
    <Show when={Boolean(props.data)}>
      <SkillsPage routeData={props.data} surface={surface} />
    </Show>
  );
}

export function SkillsPage(props: SkillsPageProps) {
  const context = useApplication();
  const surface = () => props.surface ?? "settings";
  // The synchronous request owner admits live surface props at the effect boundary.
  let admittedSurface: ReturnType<typeof surface> | undefined;
  let lastSearchScope:
    | readonly [GatewayBrowserClient | null, boolean, number, ReturnType<typeof surface>]
    | undefined;
  const [local, setLocal] = createStore<SkillsPresentation>({
    skillsFilter: "",
    skillsStatusFilter: "all",
    skillsDetailKey: null,
    skillsDetailTab: "overview",
    clawhubSearchQuery: "",
  });
  let active = true;
  let clawhubSearchTimer: {
    timeout: ReturnType<typeof setTimeout>;
    resolve: (result: PageReadResult) => void;
  } | null = null;
  let routeDataInitialized = false;
  let routeDataEnabled = true;
  let accessSignature = "";
  const skills = observeState<SkillsState>({
    ...createSkillsData(),
    get client() {
      return context.gateway.snapshot.client;
    },
    get connected() {
      return context.gateway.snapshot.phase === "connected";
    },
    get runtimeConfig() {
      return context.runtimeConfig;
    },
  });
  const data = skills.state;
  const verdictCompletion = createMemo(() => skills.read().clawhubVerdictsRead);
  const acceptedVerdicts = createMemo(() => skills.read().clawhubVerdicts);
  // Optional verdict enrichment must not hold independent inventory or detail selection.
  const readClawHubVerdicts = createDeferred(() => {
    const receipt = verdictCompletion();
    const value = acceptedVerdicts();
    return (receipt?.completion ?? Promise.resolve({ value, error: null })).then((outcome) => {
      if (outcome.error) {
        throw new Error(outcome.error);
      }
      return outcome.value;
    });
  });
  const [detailReceipt, setDetailReceipt] = createSignal<ClawHubDetailReceipt | null>(null);
  const [searchCompletion, setSearchCompletion] = createSignal<Promise<PageReadResult> | null>(
    null,
  );
  const searchRequest = createPageRequest(() => {}, {
    task: ({ client, query }: { client: GatewayBrowserClient; query: string }, { signal }) =>
      searchClawHub(client, query, signal),
    onComplete: (results) => {
      data.clawhubSearchResults = results;
    },
    onError: () => {},
  });
  const readClawHubSearch = createMemo(() => {
    const completion = searchCompletion();
    // First readiness belongs to Loading too, before request admission publishes its receipt.
    return (completion ?? Promise.resolve(null)).then((result) => {
      if (result) {
        throw result.error;
      }
      return true;
    });
  });
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: resetLoadedSkillState,
    onSnapshot: ({ snapshot }) => {
      if (snapshot.phase !== "connected" || !snapshot.hello) {
        return;
      }
      const auth = snapshot.hello.auth ?? null;
      const nextAccess = [
        hasOperatorReadAccess(auth),
        hasOperatorWriteAccess(auth),
        hasOperatorAdminAccess(auth),
      ];
      const nextSignature = nextAccess.join(":");
      if (accessSignature === nextSignature) {
        return;
      }
      accessSignature = nextSignature;
      gateway.invalidate();
      invalidateSkillRequests();
      if (!nextAccess[0]) {
        resetLoadedSkillState();
      } else {
        if (!nextAccess[1]) {
          library.reset();
        }
        if (!nextAccess[2]) {
          data.skillEdits = {};
        }
      }
    },
    invalidateRequests: invalidateSkillRequests,
    ensureInitialData: (change) => {
      if (change.becameConnected && !change.initial) {
        void loadSkills(data);
        void library.load(change.snapshot);
      }
      ensureInitialData();
    },
  });
  // Unrelated skill publications must not re-arm the detail boundary.
  const detailClient = createMemo(() => gateway.client);
  const detailEpoch = createMemo(() => gateway.epoch);
  const detailRef = createMemo(() => skills.read().clawhubDetailRef);
  const detailSnapshot = createMemo(() => skills.read().clawhubDetail);
  const detailError = createMemo(() => skills.read().clawhubDetailError);
  const detailAgent = createMemo(() => skills.read().skillsAgentId);
  const detailAgentRevision = createMemo(() => skills.read().skillsAgentRevision);
  const mutations = createSkillsMutationPresentation({
    state: data,
    readSkills: () => skills.read().skillsReport,
    scope: () => ({
      client: detailClient(),
      epoch: detailEpoch(),
      agentId: detailAgent(),
      agentRevision: detailAgentRevision(),
    }),
    readEpoch: () => gateway.readEpoch(),
    active: () => active,
  });
  const readClawHubDetail = createMemo(() => {
    const client = detailClient();
    const epoch = detailEpoch();
    const agentId = detailAgent();
    const agentRevision = detailAgentRevision();
    const ref = detailRef();
    detailSnapshot();
    detailError();
    const receipt = detailReceipt();
    if (!ref) {
      return Promise.resolve(null);
    }
    const completion =
      receipt?.client === client &&
      receipt.epoch === epoch &&
      receipt.agentId === agentId &&
      receipt.agentRevision === agentRevision &&
      receipt.ref === ref
        ? receipt.completion
        : Promise.resolve();
    return completion.then(() => {
      if (data.clawhubDetailError) {
        throw new Error(data.clawhubDetailError);
      }
      return data.clawhubDetail;
    });
  });
  const viewState = createMemo(() => ({ ...skills.read(), ...local }));
  const config = context.config ? projectApplicationConfig(context.config) : undefined;
  const library = createSkillLibrary(gateway, () => {
    config?.revision();
    return context.config;
  });
  function retirePresentation() {
    library.retire();
    mutations.retire();
  }
  const clawhubIcons = new PluginIconOwner({
    kind: "catalog",
    getFetchContext: () => pluginIconFetchContext(context),
    isConnected: () => context.gateway.snapshot.phase === "connected",
    onUrlsChange: (urls) => {
      data.clawhubIconUrls = urls;
    },
  });
  const agents = projectAgents(context.agents);
  const syncSelection = () => {
    if (!admittedSurface) {
      return;
    }
    const previous = data.skillsAgentId;
    reconcileAgentState();
    if (routeDataInitialized && previous !== data.skillsAgentId) {
      routeDataEnabled = false;
      ensureInitialData();
    }
  };
  // Route receipts admit loader data; changing surface only retargets its selection owner.
  createEffect(
    () => ({
      route: props.routeData,
      surface: surface(),
      client: gateway.client,
      connected: gateway.connected,
      epoch: gateway.epoch,
      query: local.clawhubSearchQuery,
    }),
    (current, previous) => {
      if (!previous || current.route !== previous.route || current.surface !== previous.surface) {
        if (previous && current.surface !== previous.surface) {
          retirePresentation();
        }
        admittedSurface = current.surface;
        syncSelection();
        if (!previous || current.route !== previous.route) {
          applyRouteData(current.route);
        }
        ensureInitialData();
      }
      syncSearch(
        [current.client, current.connected, current.epoch, current.surface],
        current.query,
      );
    },
  );
  onSettled(() => {
    const stopLifecycle = context.lifecycleAbortSignal
      ? listen(context.lifecycleAbortSignal, "abort", retirePresentation, { once: true })
      : () => undefined;
    let location = context.router.getState().location;
    const stopNavigation = context.router.subscribe((state) => {
      if (state.location !== location) {
        retirePresentation();
        location = state.location;
      }
    });
    // Roster receipts reconcile the request target before admitting missing skill reads.
    const stopAgents = agents.subscribe(() => {
      reconcileAgentState();
      ensureInitialData();
    });
    const selections = new Set([context.settingsAgentSelection, context.agentSelection]);
    // Retained surfaces have separate selection owners; only the admitted owner retargets.
    const stopSelections = Array.from(selections, (selection) =>
      selection.subscribe(() => {
        if (selection === agentSelection()) {
          syncSelection();
        }
      }),
    );
    let previousResults: SkillsState["clawhubSearchResults"] | undefined;
    let previousDetail: SkillsState["clawhubDetail"] | undefined;
    const syncIcons = () => {
      if (!active) {
        return;
      }
      const results = data.clawhubSearchResults;
      const detail = data.clawhubDetail;
      if (results === previousResults && detail === previousDetail) {
        return;
      }
      previousResults = results;
      previousDetail = detail;
      clawhubIcons.syncCatalog(
        [],
        [
          ...(results ?? []).flatMap((result) => (result.icon ? [result.icon] : [])),
          ...(detail?.skill?.icon ? [detail.skill.icon] : []),
          ...(detail?.owner?.image ? [detail.owner.image] : []),
        ],
      );
    };
    // Icon reconciliation waits for result/detail publication to settle.
    const stopSkills = skills.subscribe(() => onSettled(syncIcons));
    syncSelection();
    syncIcons();
    return () => {
      active = false;
      retirePresentation();
      retireSkillsReads(data);
      [stopLifecycle, stopNavigation, stopAgents, ...stopSelections, stopSkills].forEach((stop) =>
        stop(),
      );
      clearClawHubSearchTimer();
      searchRequest.cancel();
      skills.dispose();
      clawhubIcons.reset();
    };
  });

  function syncSearch(scope: NonNullable<typeof lastSearchScope>, query: string) {
    if (lastSearchScope?.every((value, index) => value === scope[index])) {
      return;
    }
    lastSearchScope = scope;
    if (scope[1] && !clawhubSearchTimer) {
      void setSearchCompletion(performSearch(query));
    }
  }

  function performSearch(query: string): Promise<PageReadResult> {
    searchRequest.reset();
    const snapshot = context.gateway.snapshot;
    const client = snapshot.client;
    if (
      snapshot.phase !== "connected" ||
      !canReadSkills() ||
      admittedSurface !== "discovery" ||
      !client
    ) {
      return Promise.resolve(null);
    }
    void searchRequest.run({ client, query });
    return searchRequest.read!;
  }

  function agentSelection() {
    return admittedSurface === "settings" ? context.settingsAgentSelection : context.agentSelection;
  }

  function reconcileAgentState() {
    const agentState = context.agents.state;
    const previousAgentId = data.skillsAgentId;
    setSkillsAgentId(data, agentSelection().state.selectedId, retirePresentation);
    if (admittedSurface === "discovery" && agentState.agentsList) {
      reconcileSkillsAgentId(data, agentState.agentsList, retirePresentation);
    }
    if (previousAgentId !== data.skillsAgentId) {
      selectSkill(null);
      closeDetail();
    }
  }

  function invalidateSkillRequests() {
    mutations.retire();
    library.invalidateRequests();
    retireSkillsReads(data);
    setDetailReceipt(null);
    data.skillsAgentRevision++;
    data.skillsLoading = false;
    data.skillOperation = null;
    setSearchCompletion(null);
    searchRequest.reset();
    clearClawHubSearchTimer();
    clawhubIcons.reconcileKeys(new Set(Object.keys(data.clawhubIconUrls)));
  }

  function resetLoadedSkillState() {
    mutations.retire();
    retireSkillsReads(data);
    setDetailReceipt(null);
    library.reset();
    setSearchCompletion(null);
    searchRequest.reset();
    clearClawHubSearchTimer();
    if (routeDataInitialized) {
      routeDataEnabled = false;
    }
    selectSkill(null);
    Object.assign(data, createSkillsData(), {
      skillsAgentRevision: data.skillsAgentRevision + 1,
    });
    clawhubIcons.reset();
  }

  function applyRouteData(route: SkillsRouteData | undefined) {
    if (!route) {
      return;
    }
    routeDataInitialized = true;
    routeDataEnabled = true;
    if (!gateway.isRouteDataCurrent(route) || route.agents !== context.agents || !canReadSkills()) {
      routeDataEnabled = false;
      return;
    }
    const selection = agentSelection().state;
    // A preload may finish after another explicit choice, including an A→B→A switch.
    if (agentSelection().intentRevision !== route.selectionIntentRevision) {
      routeDataEnabled = false;
      reconcileAgentState();
      return;
    }
    setSkillsAgentId(data, route.selectedAgentId, retirePresentation);
    if (route.selectedAgentId && selection.selectedId !== route.selectedAgentId) {
      agentSelection().set(route.selectedAgentId);
    }
    reconcileAgentState();
    if (data.skillsAgentId !== route.selectedAgentId) {
      routeDataEnabled = false;
      return;
    }
    routeDataEnabled = true;
    retireSkillsReads(data);
    data.skillsLoading = false;
    data.skillsReport = route.report;
    data.skillsError = route.error;
    if (route.report) {
      void loadClawHubSecurityVerdicts(data, route.report);
    }
    if (route.clawhubRef && route.clawhubRef !== data.clawhubDetailRef) {
      openClawHubDetail(route.clawhubRef);
    }
  }

  function ensureInitialData() {
    if (!admittedSurface || !canReadSkills()) {
      return;
    }
    const snapshot = context.gateway.snapshot;
    library.ensureLoaded(snapshot);
    if (
      routeDataEnabled ||
      !routeDataInitialized ||
      snapshot.phase !== "connected" ||
      !snapshot.client
    ) {
      return;
    }
    const agentState = context.agents.state;
    if (!agentState.agentsList) {
      if (!agentState.agentsLoading) {
        void loadAgents();
      }
      return;
    }
    reconcileAgentState();
    if (!data.skillsReport && !data.skillsLoading) {
      void loadSkills(data);
    }
  }

  function canReadSkills() {
    return hasOperatorReadAccess(context.gateway.snapshot.hello?.auth ?? null);
  }

  async function loadAgents() {
    const source = context.agents;
    await source.ensureList();
    if (context.agents === source) {
      reconcileAgentState();
    }
  }

  async function refreshPage() {
    await Promise.all([refreshSkills(data, loadAgents), library.load()]);
  }

  function changeClawHubQuery(query: string) {
    setLocal((state) => {
      state.clawhubSearchQuery = query;
    });
    data.clawhubSearchResults = null;
    data.clawhubInstallMessage = null;
    clearClawHubSearchTimer();
    searchRequest.reset();
    void setSearchCompletion(
      new Promise<PageReadResult>((resolve) => {
        const timeout = setTimeout(() => {
          clawhubSearchTimer = null;
          void performSearch(query).then(resolve);
        }, 300);
        clawhubSearchTimer = { timeout, resolve };
      }),
    );
  }

  function clearClawHubSearchTimer() {
    if (clawhubSearchTimer) {
      clearTimeout(clawhubSearchTimer.timeout);
      clawhubSearchTimer.resolve(null);
      clawhubSearchTimer = null;
    }
  }

  function selectSkill(key: string | null) {
    setLocal((state) => {
      state.skillsDetailKey = key;
      state.skillsDetailTab = "overview";
    });
  }

  function openClawHubDetail(ref: string) {
    const client = data.client;
    const epoch = gateway.readEpoch();
    const agentId = data.skillsAgentId;
    const agentRevision = data.skillsAgentRevision;
    const completion = loadClawHubDetail(data, ref);
    setDetailReceipt({ client, epoch, agentId, agentRevision, ref, completion });
  }

  function closeDetail() {
    setDetailReceipt(null);
    closeClawHubDetail(data);
  }

  function changeDetailTab(tab: SkillDetailTab) {
    setLocal((state) => {
      state.skillsDetailTab = tab;
    });
    if (tab === "card" && local.skillsDetailKey) {
      void loadSkillCard(data, local.skillsDetailKey);
    }
  }

  function canUpdateSkills(): boolean {
    return canCallGatewayMethod(gateway.snapshot, "skills.update", "operator.admin");
  }

  function canInstallSkills(): boolean {
    return canCallGatewayMethod(gateway.snapshot, "skills.install", "operator.admin");
  }

  function canInstallFromClawHub(): boolean {
    // The library owns the destination; a pending or failed first load is not workspace consent.
    const current = library.state;
    return (
      current.list !== null &&
      !current.loading &&
      (library.showWorkspace()
        ? canInstallSkills()
        : library.canWrite() && Boolean(current.list.profileId))
    );
  }

  function navigateSkills(route: "skills" | "skill-settings") {
    context.navigate(route, {
      search: data.skillsAgentId ? `?agent=${encodeURIComponent(data.skillsAgentId)}` : "",
    });
  }

  return (
    <openclaw-skills-page>
      {surface() === "discovery" ? (
        <PluginsHubHeader
          active="skills"
          onSelect={(tab) => {
            if (tab !== "skills") {
              context.navigate(tab);
            }
          }}
          secondaryAction={{
            label: t("skillDiscovery.settings"),
            icon: <Icon name="settings" />,
            onClick: () => navigateSkills("skill-settings"),
          }}
        />
      ) : (
        <SettingsPageHeader title={t("tabs.skills")} subtitle={t("subtitles.skills")} />
      )}
      <SettingsWorkspace>
        <div
          id={surface() === "discovery" ? PLUGINS_HUB_PANEL_ID : undefined}
          role={surface() === "discovery" ? "tabpanel" : undefined}
          aria-labelledby={surface() === "discovery" ? "plugins-tab-skills" : undefined}
        >
          <Skills
            state={viewState()}
            mutationSkills={mutations.rows()}
            saving={mutations.saving()}
            readClawHubDetail={readClawHubDetail}
            readClawHubVerdicts={readClawHubVerdicts}
            readClawHubSearch={readClawHubSearch}
            clawhubSearchEpoch={gateway.epoch}
            surface={surface()}
            libraryEntries={library.entries()}
            onLibraryOpen={(skillId) => void library.open(skillId)}
            library={
              surface() === "discovery" ? (
                <>
                  <SkillLibraryFeedback library={library} />
                  <SkillLibraryDialogs library={library} />
                </>
              ) : (
                <SkillLibrary
                  library={library}
                  navigationActions={
                    <>
                      <button type="button" class="btn" onClick={() => navigateSkills("skills")}>
                        <Icon name="search" />
                        {t("skillDiscovery.search")}
                      </button>
                      <button
                        type="button"
                        class="btn"
                        onClick={() => context.navigate("skill-workshop")}
                      >
                        {t("pluginsPage.workshopTab")}
                      </button>
                    </>
                  }
                />
              )
            }
            showInventory={library.showWorkspace()}
            canUpdate={canUpdateSkills()}
            canInstall={canInstallFromClawHub()}
            loading={
              skills.read().skillsLoading || agents.read().agentsLoading || library.state.busy
            }
            error={skills.read().skillsError ?? agents.read().agentsError}
            onFilterChange={(next) =>
              setLocal((state) => {
                state.skillsFilter = next;
              })
            }
            onStatusFilterChange={(next) =>
              setLocal((state) => {
                state.skillsStatusFilter = next;
              })
            }
            onRefresh={() => void refreshPage()}
            onToggle={(key, enabled) => {
              if (canUpdateSkills()) {
                void mutations.run(() => updateSkillEnabled(data, key, enabled, canUpdateSkills), {
                  skillKey: key,
                  enabled,
                });
              }
            }}
            onEdit={(key, value) => {
              if (canUpdateSkills()) {
                updateSkillEdit(data, key, value);
              }
            }}
            onSaveKey={(key) => {
              if (canUpdateSkills()) {
                void mutations.run(() => saveSkillApiKey(data, key, canUpdateSkills));
              }
            }}
            onInstall={(skillKey, name, installId) => {
              if (canInstallSkills()) {
                void mutations.run(() => installSkill(data, skillKey, name, installId));
              }
            }}
            onDetailOpen={selectSkill}
            onDetailClose={() =>
              setLocal((state) => {
                state.skillsDetailKey = null;
              })
            }
            onDetailTabChange={changeDetailTab}
            onClawHubQueryChange={changeClawHubQuery}
            onClawHubDetailOpen={openClawHubDetail}
            onClawHubDetailClose={closeDetail}
            onClawHubInstall={(ref, version) => {
              if (!canInstallFromClawHub()) {
                return;
              }
              if (!library.showWorkspace()) {
                closeDetail();
                library.edit((state) => {
                  state.importSource = { slug: ref, version };
                  state.importSlug = "";
                });
                library.setImportOpen(true);
              } else {
                void mutations.run(() => installFromClawHub(data, ref, version));
              }
            }}
          />
        </div>
      </SettingsWorkspace>
    </openclaw-skills-page>
  );
}
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-skills-page": HTMLAttributes<HTMLElement>;
    }
  }
}
