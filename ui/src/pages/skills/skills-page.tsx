import type { SkillsSearchParams } from "@openclaw/gateway-protocol";
import {
  createDeferred,
  createEffect,
  createMemo,
  createSignal,
  createStore,
  onSettled,
  refresh,
  Show,
} from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import {
  hasOperatorAdminAccess,
  hasOperatorReadAccess,
  hasOperatorWriteAccess,
} from "../../app/operator-access.ts";
import { FloatingHeaderActions } from "../../components/solid/floating-header-actions.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { projectApplicationConfig } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  loadSkillCategories,
  type SkillCategoryDirectory,
} from "../../lib/skills/clawhub-search.ts";
import {
  closeClawHubDetail,
  createSkillsChangeReloader,
  installFromClawHub,
  installSkill,
  loadClawHubDetail,
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
import { pluginsHubPanel } from "../plugins/plugins-hub.ts";
import { createSkillLibrary } from "./library-state.ts";
import { SkillLibraryNavigation, SkillLibraryPageMenu } from "./library-toolbar.tsx";
import { SkillLibrary, SkillLibraryDialogs, SkillLibraryFeedback } from "./library-view.tsx";
import { createSkillsMutationPresentation } from "./mutation-presentation.ts";
import { createSkillPages } from "./skill-page-route.ts";
import { createSkillsDiscoveryRequest } from "./skills-discovery-request.ts";
import { SkillsHeader } from "./skills-header.tsx";
import { createSkillsData } from "./skills-page-state.ts";
import type {
  ClawHubDetailReceipt,
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
    clawhubSearchQuery: "",
    clawhubCategory: null,
  });
  let active = true;
  let routeDataInitialized = false;
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
  const runtimeConfig = projectOwner(context.runtimeConfig, (owner) => owner.state);
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
  const search = createSkillsDiscoveryRequest(data);
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
  // Taxonomy is optional: it never holds the ordinary feed or installed inventory.
  const categoryClient = createMemo(() =>
    surface() === "discovery" &&
    canCallGatewayMethod(gateway.snapshot, "skills.categories", "operator.read")
      ? gateway.client
      : null,
  );
  const categoryDirectory = createMemo(() => {
    detailEpoch();
    const client = categoryClient();
    // Each registry starts with unknown grouping, without holding route and search admission.
    return createDeferred<SkillCategoryDirectory | null>(
      () => (client ? loadSkillCategories(client) : { categories: [] }),
      { loadingValue: null },
    );
  });
  const detailRef = createMemo(() => skills.read().clawhubDetailRef);
  const detailSnapshot = createMemo(() => skills.read().clawhubDetail);
  const detailError = createMemo(() => skills.read().clawhubDetailError);
  const detailAgent = createMemo(() => skills.read().skillsAgentId);
  const detailAgentRevision = createMemo(() => skills.read().skillsAgentRevision);
  const detailScope = () => ({
    client: detailClient(),
    epoch: detailEpoch(),
    agentId: detailAgent(),
    agentRevision: detailAgentRevision(),
  });
  const mutations = createSkillsMutationPresentation({
    state: data,
    readSkills: () => skills.read().skillsReport,
    scope: detailScope,
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
      ensureInitialData();
    }
  };
  // The address owns which skill page is open; the list stays mounted behind it.
  const pageRoute = createSkillPages({
    context,
    surface,
    scope: detailScope,
    report: () => skills.read().skillsReport,
    openedKey: () => local.skillsDetailKey,
    setOpenedKey: (skillKey) => setLocal((state) => void (state.skillsDetailKey = skillKey)),
    loadCard: (skillKey) => void loadSkillCard(data, skillKey),
    clawhubRef: () => data.clawhubDetailRef,
    openClawHub: openClawHubDetail,
    closeClawHub: closeDetail,
  });
  // Route receipts admit loader data; changing surface only retargets its selection owner.
  createEffect(
    () => ({
      route: props.routeData,
      surface: surface(),
      client: gateway.client,
      connected: gateway.connected,
      epoch: gateway.epoch,
      query: local.clawhubSearchQuery,
      skillPage: pageRoute.readSnapshot(),
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
      pageRoute.synchronizeReads(current.skillPage, previous?.skillPage);
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
        // Moving between the list and a skill's page stays inside this page's presentation.
        if (state.location.pathname !== location.pathname) {
          retirePresentation();
        }
        location = state.location;
        pageRoute.setLocation(location);
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
    const changes = createSkillsChangeReloader(data);
    const stopChanges = context.gateway.subscribeEvents(changes.onEvent);
    // Icon reconciliation waits for result/detail publication to settle.
    const stopState = skills.subscribe(() => {
      onSettled(syncIcons);
      changes.onStateChange();
    });
    const stopSkills = () => [stopChanges, stopState].forEach((stop) => stop());
    syncSelection();
    syncIcons();
    return () => {
      active = false;
      retirePresentation();
      retireSkillsReads(data);
      [stopLifecycle, stopNavigation, stopAgents, ...stopSelections, stopSkills].forEach((stop) =>
        stop(),
      );
      search.reset();
      skills.dispose();
      clawhubIcons.reset();
    };
  });

  function syncSearch(scope: NonNullable<typeof lastSearchScope>, query: string) {
    if (lastSearchScope?.every((value, index) => value === scope[index])) {
      return;
    }
    lastSearchScope = scope;
    // A category and its cursor belong to the registry on the previous connection.
    setLocal((state) => void (state.clawhubCategory = null));
    // The raw gateway may be connected before this page has admitted that connection.
    if (!scope[0] || !scope[1]) {
      search.reset();
      return;
    }
    performSearch({ query });
  }

  function performSearch(params: SkillsSearchParams, debounce = false) {
    const snapshot = gateway.snapshot;
    if (
      snapshot?.phase !== "connected" ||
      !hasOperatorReadAccess(snapshot.hello?.auth ?? null) ||
      admittedSurface !== "discovery" ||
      !snapshot.client
    ) {
      search.reset();
      return;
    }
    search.run(snapshot.client, params, debounce);
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
      // The open page reads again for the new agent once its scope settles.
      pageRoute.reset();
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
    search.reset();
    clawhubIcons.reconcileKeys(new Set(Object.keys(data.clawhubIconUrls)));
  }

  function resetLoadedSkillState() {
    mutations.retire();
    retireSkillsReads(data);
    setDetailReceipt(null);
    library.reset();
    search.reset();
    pageRoute.reset();
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
    if (!gateway.isRouteDataCurrent(route) || route.agents !== context.agents || !canReadSkills()) {
      return;
    }
    const selection = agentSelection().state;
    // A preload may finish after another explicit choice, including an A→B→A switch.
    if (agentSelection().intentRevision !== route.selectionIntentRevision) {
      reconcileAgentState();
      return;
    }
    setSkillsAgentId(data, route.selectedAgentId, retirePresentation);
    if (route.selectedAgentId && selection.selectedId !== route.selectedAgentId) {
      agentSelection().set(route.selectedAgentId);
    }
    reconcileAgentState();
    if (data.skillsAgentId !== route.selectedAgentId) {
      return;
    }
    retireSkillsReads(data);
    data.skillsLoading = false;
    data.skillsError = route.error;
    if (!route.error) {
      void loadSkills(data, { reportRead: route.reportRead });
    }
  }

  function ensureInitialData() {
    if (!admittedSurface || !canReadSkills()) {
      return;
    }
    const snapshot = context.gateway.snapshot;
    library.ensureLoaded(snapshot);
    if (!routeDataInitialized || snapshot.phase !== "connected" || !snapshot.client) {
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
    if (!data.skillsReport && !data.skillsLoading && !data.skillsError) {
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
    data.clawhubInstallMessage = null;
    performSearch({ query, category: local.clawhubCategory?.slug }, Boolean(query.trim()));
  }

  function selectCategory(category: SkillsPresentation["clawhubCategory"]) {
    if (local.clawhubCategory?.slug === category?.slug) {
      return;
    }
    setLocal((state) => void (state.clawhubCategory = category));
    data.clawhubInstallMessage = null;
    performSearch({ query: local.clawhubSearchQuery, category: category?.slug });
  }

  function loadNextPage() {
    const cursor = search.nextCursor();
    if (cursor) {
      performSearch({
        query: local.clawhubSearchQuery,
        category: local.clawhubCategory?.slug,
        cursor,
      });
    }
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

  const libraryNavigation = {
    onSearch: () => pageRoute.navigateList("skills"),
    onWorkshop: () => context.navigate("skill-workshop"),
  };
  const libraryPageMenu = () => {
    const menu = () => <SkillLibraryPageMenu library={library} {...libraryNavigation} />;
    return <FloatingHeaderActions fallback={menu()}>{menu()}</FloatingHeaderActions>;
  };
  return (
    <openclaw-skills-page>
      <Show when={!pageRoute.page()}>
        <SkillsHeader
          surface={surface()}
          onNavigate={(tab) => context.navigate(tab)}
          onSettings={() => pageRoute.navigateList("skill-settings")}
        />
      </Show>
      <SettingsWorkspace>
        <div
          // Bound layout work for the large installed inventory without containing discovery.
          style={{ contain: surface() === "settings" ? "layout" : undefined }}
          {...(surface() === "discovery" ? pluginsHubPanel("skills") : {})}
        >
          <Skills
            state={viewState()}
            mutationSkills={mutations.rows()}
            saving={mutations.saving()}
            toggleSavingSkillKey={mutations.toggle()?.skillKey}
            toggleDisabled={
              agents.read().agentsLoading ||
              library.state.busy ||
              ((skills.read().skillsLoading || skills.read().skillOperation !== null) &&
                skills.read().skillOperation !== mutations.toggle()?.operation)
            }
            readClawHubDetail={readClawHubDetail}
            readClawHubVerdicts={readClawHubVerdicts}
            readClawHubSearch={search.read}
            readCategories={() => categoryDirectory()()}
            onRetryCategories={() => void refresh(categoryDirectory())}
            onCategoryChange={selectCategory}
            hasNextPage={Boolean(search.nextCursor())}
            onLoadMore={loadNextPage}
            clawhubSearchEpoch={gateway.epoch}
            surface={surface()}
            libraryEntries={library.state.list ? library.entries() : undefined}
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
                  pageMenu={libraryPageMenu}
                  navigationActions={<SkillLibraryNavigation {...libraryNavigation} />}
                />
              )
            }
            pageMenu={surface() === "discovery" ? undefined : libraryPageMenu}
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
            apiKeyConfig={{
              snapshot: () => runtimeConfig.read().configSnapshot,
              error: () => runtimeConfig.read().lastError,
              retry: () => void context.runtimeConfig.refreshDisplay(),
            }}
            onSaveKey={(key, replaceable) => {
              if (canUpdateSkills()) {
                // Read at save and again at dispatch, from the owner's current snapshot.
                const current = () => replaceable(context.runtimeConfig.state.configSnapshot, key);
                void mutations.run(() => saveSkillApiKey(data, key, current, canUpdateSkills));
              }
            }}
            onInstall={(skillKey, name, installId) => {
              if (canInstallSkills()) {
                void mutations.run(() => installSkill(data, skillKey, name, installId));
              }
            }}
            listHref={pageRoute.listHref()}
            onDetailOpen={pageRoute.openInstalled}
            onDetailClose={pageRoute.close}
            onSkillCardRetry={(skillKey) => void loadSkillCard(data, skillKey)}
            onClawHubQueryChange={changeClawHubQuery}
            onClawHubDetailOpen={pageRoute.openClawHub}
            onClawHubInstall={(ref, version) => {
              if (!canInstallFromClawHub()) {
                return;
              }
              if (!library.showWorkspace()) {
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
