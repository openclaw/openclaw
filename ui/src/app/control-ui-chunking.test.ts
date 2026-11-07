// @vitest-environment node
import { build } from "vite";
import { describe, expect, it } from "vitest";
import {
  controlUiBootManifestKey,
  controlUiCodeSplitting,
  controlUiStableChunkName,
} from "../../config/control-ui-chunking.ts";

const modulePath = (relative: string) => new URL(relative, import.meta.url).pathname;

function importClosure(importsFor: (file: string) => readonly string[]) {
  return (fileName: string) => {
    const visited = new Set<string>();
    const visit = (file: string) => {
      if (!visited.has(file)) {
        visited.add(file);
        importsFor(file).forEach(visit);
      }
    };
    visit(fileName);
    return visited;
  };
}

function buildFixture(
  entry: string,
  sources: Map<string, string>,
  codeSplitting = controlUiCodeSplitting,
) {
  return build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      {
        name: entry.slice(1),
        enforce: "pre",
        resolveId: (id) => (sources.has(id) ? id : null),
        load: (id) => sources.get(id) ?? null,
      },
    ],
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: entry,
        preserveEntrySignatures: "allow-extension",
        output: { codeSplitting, strictExecutionOrder: true },
      },
    },
  });
}

describe("Control UI build chunking", () => {
  it("consolidates lazy Settings helpers while keeping validation behind the editor", async () => {
    const page = modulePath("../pages/config/config-page.tsx");
    const editor = modulePath("../components/config-form.render.tsx");
    const lightConsumer = modulePath("../pages/plugins/credential-presentation.tsx");
    const analyze = modulePath("../components/config-form.analyze.ts");
    const constraints = modulePath("../components/config-form.constraints.ts");
    const validator = modulePath("../../../packages/normalization-core/src/json-schema.ts");
    const shared = modulePath("../components/config-form.shared.ts");
    const sensitive = modulePath("../../../src/config/sensitive-paths.ts");
    const utils = modulePath("../lib/config-form-utils.ts");
    const hints = modulePath("../i18n/lib/config-hint-translation.ts");
    const items = modulePath("../components/config-form.array-items.ts");
    const controls = modulePath("../components/solid/settings-ui.tsx");
    const header = modulePath("../pages/config/settings-section-header.tsx");
    const copy = modulePath("../i18n/locales/en-settings.ts");
    const entry = "\0settings-helper-fixture";
    const result = await buildFixture(
      entry,
      new Map([
        [
          entry,
          `export const settings = () => import(${JSON.stringify(page)}); export const credentials = () => import(${JSON.stringify(lightConsumer)});`,
        ],
        [
          page,
          `import { analyze } from ${JSON.stringify(analyze)}; import { items } from ${JSON.stringify(items)}; import { header } from ${JSON.stringify(header)}; export const render = () => analyze + items + header; export const edit = () => import(${JSON.stringify(editor)});`,
        ],
        [
          analyze,
          `import { items } from ${JSON.stringify(items)}; import { shared } from ${JSON.stringify(shared)}; export const analyze = items + shared + 'analysis';`,
        ],
        [
          constraints,
          `import { items } from ${JSON.stringify(items)}; import { shared } from ${JSON.stringify(shared)}; import { validator } from ${JSON.stringify(validator)}; export const constraints = items + shared + validator + 'constraints';`,
        ],
        [validator, "export const validator = 'value validation';"],
        [
          shared,
          `import { sensitive } from ${JSON.stringify(sensitive)}; export const shared = sensitive + 'shared';`,
        ],
        [sensitive, "export const sensitive = 'sensitive';"],
        [
          items,
          `import { value } from ${JSON.stringify(utils)}; export const items = value + 'items';`,
        ],
        [
          utils,
          `import { hint } from ${JSON.stringify(hints)}; export const value = hint + 'value';`,
        ],
        [hints, "export const hint = 'hint';"],
        [
          header,
          `import { control } from ${JSON.stringify(controls)}; export const header = control + 'header';`,
        ],
        [controls, "export const control = 'control';"],
        [
          lightConsumer,
          `import { value } from ${JSON.stringify(utils)}; export const credential = value;`,
        ],
        [
          editor,
          `import { constraints } from ${JSON.stringify(constraints)}; import { copy } from ${JSON.stringify(copy)}; export const edit = () => constraints + copy;`,
        ],
        [copy, "export const copy = 'optional editor copy';"],
      ]),
    );
    if (Array.isArray(result) || !("output" in result)) {
      throw new Error("Expected one in-memory build");
    }
    const chunks = result.output.filter((asset) => asset.type === "chunk");
    const chunkFor = (id: string) => chunks.find((chunk) => id in chunk.modules)!;
    const reachable = importClosure(
      (file) => chunks.find((chunk) => chunk.fileName === file)!.imports,
    );
    const analysisChunk = chunkFor(analyze);
    const utilsChunk = chunkFor(utils);
    const controlsChunk = chunkFor(controls);
    for (const [name, chunk, modules] of [
      ["config-form-analysis-runtime", analysisChunk, [analyze, shared, sensitive]],
      ["config-form-utils-runtime", utilsChunk, [utils, hints, items]],
      ["settings-controls-runtime", controlsChunk, [controls, header]],
    ] as const) {
      expect(chunk.fileName).toContain(name);
      expect(modules.every((id) => id in chunk.modules)).toBe(true);
    }
    const pageChunk = chunkFor(page);
    const pageImports = reachable(pageChunk.fileName);
    const startupImports = reachable(chunks.find((chunk) => chunk.isEntry)!.fileName);
    for (const chunk of [pageChunk, analysisChunk, utilsChunk, controlsChunk]) {
      expect(pageImports.has(chunk.fileName)).toBe(true);
      expect(startupImports.has(chunk.fileName)).toBe(false);
    }
    const editorChunk = chunkFor(editor);
    const editorImports = reachable(editorChunk.fileName);
    for (const id of [editor, constraints, validator, copy]) {
      expect(pageImports.has(chunkFor(id).fileName)).toBe(false);
      expect(editorImports.has(chunkFor(id).fileName)).toBe(true);
    }
    expect(pageChunk.dynamicImports).toContain(editorChunk.fileName);
    const lightImports = reachable(chunkFor(lightConsumer).fileName);
    expect(lightImports.has(utilsChunk.fileName)).toBe(true);
    for (const chunk of [
      pageChunk,
      analysisChunk,
      controlsChunk,
      editorChunk,
      chunkFor(constraints),
      chunkFor(validator),
      chunkFor(copy),
    ]) {
      expect(lightImports.has(chunk.fileName)).toBe(false);
    }
  });

  it("keeps the real schema analyzer independent of the optional value validator", async () => {
    const analyze = modulePath("../components/config-form.analyze.ts");
    const constraints = modulePath("../components/config-form.constraints.ts");
    const validator = modulePath("../../../packages/normalization-core/src/json-schema.ts");
    const entry = "\0config-analysis-boundary";
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      resolve: {
        alias: [
          {
            find: /^@openclaw\/normalization-core\/(.+)$/u,
            replacement: modulePath("../../../packages/normalization-core/src/$1.ts"),
          },
        ],
      },
      plugins: [
        {
          name: "config-analysis-boundary",
          resolveId: (id) => (id === entry ? id : null),
          load: (id) =>
            id === entry
              ? `export { analyzeConfigSchema } from ${JSON.stringify(analyze)}; export const editor = () => import(${JSON.stringify(constraints)});`
              : null,
        },
      ],
      build: {
        write: false,
        minify: false,
        rolldownOptions: {
          input: entry,
          // Translation content does not affect the schema/validator import boundary.
          external: /^virtual:openclaw-control-ui-locale/u,
          preserveEntrySignatures: "allow-extension",
          output: { codeSplitting: controlUiCodeSplitting, strictExecutionOrder: true },
        },
      },
    });
    if (Array.isArray(result) || !("output" in result)) {
      throw new Error("Expected one in-memory build");
    }
    const chunks = result.output.filter((asset) => asset.type === "chunk");
    const reachable = importClosure(
      (file) => chunks.find((chunk) => chunk.fileName === file)?.imports ?? [],
    );
    const modulesFrom = (fileName: string): Set<string> => {
      const visited = reachable(fileName);
      return new Set(
        chunks
          .filter((chunk) => visited.has(chunk.fileName))
          .flatMap((chunk) =>
            Object.entries(chunk.modules)
              .filter(([, module]) => module.renderedLength > 0)
              .map(([id]) => id),
          ),
      );
    };
    const startup = modulesFrom(chunks.find((chunk) => chunk.isEntry)!.fileName);
    const editor = modulesFrom(chunks.find((chunk) => constraints in chunk.modules)!.fileName);
    expect(startup.has(analyze)).toBe(true);
    for (const id of [constraints, validator]) {
      expect(startup.has(id)).toBe(false);
      expect(editor.has(id)).toBe(true);
    }
    expect([...startup].some((id) => id.includes("/node_modules/typebox/"))).toBe(false);
    expect([...editor].some((id) => id.includes("/node_modules/typebox/"))).toBe(true);
  });

  it("keeps the creator runtime and its copy outside shared admission and virtualizer chunks", async () => {
    const owner = modulePath("../pages/templates/creator-owner.ts");
    const flow = modulePath("../pages/templates/creator-flow.ts");
    const copy = modulePath("../i18n/locales/en-template-creator.ts");
    const title = modulePath("../i18n/locales/en-agents-home.ts");
    const virtualizer = modulePath("../../node_modules/@tanstack/virtual-core/dist/esm/index.js");
    const entry = "\0creator-owner-fixture";
    const result = await buildFixture(
      entry,
      new Map([
        [
          entry,
          `export { open } from ${JSON.stringify(owner)}; export { measure } from ${JSON.stringify(virtualizer)};`,
        ],
        [
          owner,
          `import { title } from ${JSON.stringify(title)}; export const open = () => import(${JSON.stringify(flow)}).then(m => m.start(title));`,
        ],
        [
          flow,
          `import { copy } from ${JSON.stringify(copy)}; export const start = title => title + copy;`,
        ],
        [copy, "export const copy = 'Optional creator copy';"],
        [title, "export const title = 'Create Template';"],
        [virtualizer, "export const measure = () => 1;"],
      ]),
    );
    if (Array.isArray(result) || !("output" in result)) {
      throw new Error("Expected one in-memory build");
    }
    const chunks = result.output.filter((asset) => asset.type === "chunk");
    const cold = chunks.find((chunk) => flow in chunk.modules)!;
    expect(cold.fileName).toContain("template-creator-runtime");
    expect(copy in cold.modules).toBe(true);
    const reachable = importClosure(
      (file) => chunks.find((chunk) => chunk.fileName === file)?.imports ?? [],
    )(chunks.find((chunk) => chunk.isEntry)!.fileName);
    expect(reachable.has(cold.fileName)).toBe(false);
    expect(
      chunks
        .filter((chunk) => reachable.has(chunk.fileName))
        .some((chunk) => owner in chunk.modules),
    ).toBe(true);
  });
  it("keeps optional parsing and device signing outside the eager graph", async () => {
    const zod = modulePath("../../node_modules/zod/index.js");
    const json5 = modulePath("../../node_modules/json5/dist/index.mjs");
    const gatewayMethods = modulePath("../lib/gateway-methods.ts");
    const solid = modulePath("../../node_modules/solid-js/dist/solid.js");
    const verdict = modulePath("../../node_modules/@solidjs/signals/dist/prod/core/verdict.js");
    const signer = modulePath("../../node_modules/@noble/ed25519/index.js");
    const markdown = modulePath("../../node_modules/markdown-it/dist/markdown-it.mjs");
    const entities = modulePath("../../node_modules/entities/dist/index.js");
    const motion = modulePath("../components/mascot-animator.ts");
    const channels = modulePath("../lib/channels/index.ts");
    const entry = "\0config-parser-fixture";
    const sources = new Map([
      [
        entry,
        `export { validate } from ${JSON.stringify(zod)}; export { canCall } from ${JSON.stringify(gatewayMethods)}; export { signal } from ${JSON.stringify(solid)}; export { pending } from ${JSON.stringify(verdict)}; export const warm = () => import(${JSON.stringify(json5)}); export const sign = () => import(${JSON.stringify(signer)}); export const render = () => import(${JSON.stringify(markdown)}); export const animate = () => import(${JSON.stringify(motion)}); export const openChannels = () => import(${JSON.stringify(channels)});`,
      ],
      [zod, "export const validate = () => true;"],
      [json5, "export const parse = () => ({});"],
      [gatewayMethods, "export const canCall = () => true;"],
      [solid, "export const signal = () => 1;"],
      [verdict, "export const pending = () => false;"],
      [signer, "export const sign = () => 'signature';"],
      [motion, "export class MascotAnimator {}"],
      [channels, "export const createChannelCapability = () => ({});"],
      [markdown, `export { decode as render } from ${JSON.stringify(entities)};`],
      [entities, "export const decode = () => 'decoded';"],
    ]);
    const result = await buildFixture(entry, sources);
    if (Array.isArray(result) || !("output" in result)) {
      throw new Error("Expected one in-memory build");
    }
    const chunks = result.output.filter((asset) => asset.type === "chunk");
    const entryChunk = chunks.find((chunk) => chunk.isEntry)!;
    const parserChunk = chunks.find((chunk) => json5 in chunk.modules)!;
    const dependencies = importClosure(
      (file) => chunks.find((chunk) => chunk.fileName === file)?.imports ?? [],
    )(entryChunk.fileName);
    expect(dependencies.has(parserChunk.fileName)).toBe(false);
    expect(entryChunk.dynamicImports).toContain(parserChunk.fileName);
    const signerChunk = chunks.find((chunk) => signer in chunk.modules)!;
    expect(dependencies.has(signerChunk.fileName)).toBe(false);
    expect(entryChunk.dynamicImports).toContain(signerChunk.fileName);
    const motionChunk = chunks.find((chunk) => motion in chunk.modules)!;
    expect(dependencies.has(motionChunk.fileName)).toBe(false);
    expect(entryChunk.dynamicImports).toContain(motionChunk.fileName);
    expect(motionChunk.fileName).toContain("mascot-motion-runtime");
    const channelsChunk = chunks.find((chunk) => channels in chunk.modules)!;
    expect(dependencies.has(channelsChunk.fileName)).toBe(false);
    expect(entryChunk.dynamicImports).toContain(channelsChunk.fileName);
    expect(channelsChunk.fileName).toContain("channels-runtime");
    const markdownChunk = chunks.find((chunk) => markdown in chunk.modules)!;
    expect(dependencies.has(markdownChunk.fileName)).toBe(false);
    expect(entryChunk.dynamicImports).toContain(markdownChunk.fileName);
    expect(chunks.find((chunk) => entities in chunk.modules)?.fileName).toBe(
      markdownChunk.fileName,
    );
    expect(chunks.find((chunk) => solid in chunk.modules)?.fileName).toBe(
      chunks.find((chunk) => verdict in chunk.modules)?.fileName,
    );
  });

  it("keeps routes and optional code lazy with one shared stylesheet", async () => {
    const chat = modulePath("../pages/chat/chat-pane.tsx");
    const newSession = modulePath("../pages/new-session/new-session-page.tsx");
    const usage = modulePath("../pages/usage/usage-page.tsx");
    const meetings = modulePath("../pages/meetings/meetings-page.tsx");
    const markdownTables = modulePath("../components/markdown-tables.ts");
    const markdownLinkDisplay = modulePath("../components/markdown-link-display.ts");
    const markdownBlockPresentation = modulePath("../components/markdown-block-presentation.ts");
    const reactiveFormat = modulePath("../lib/reactive/format.ts");
    const permissionError = modulePath("../lib/permission-error.ts");
    const permissionCopy = modulePath("../i18n/locales/en-permission-errors.ts");
    const portals = modulePath("../pages/portals/portals-page.tsx");
    const visiblePoll = modulePath("../lib/reactive/visible-poll.ts");
    const runFrame = modulePath("../pages/chat/components/chat-agent-run-frame.tsx");
    const runStream = modulePath("../pages/chat/components/chat-message-stream-view.tsx");
    const sourcePreviews = modulePath("../lib/chat/source-previews.ts");
    const sourcePreviewView = modulePath("../pages/chat/components/chat-source-previews.tsx");
    const permissionCard = modulePath("../pages/chat/components/chat-permission-card.tsx");
    const permissionLabels = modulePath("../i18n/locales/en-chat-permissions.ts");
    const processRow = modulePath("../pages/chat/components/chat-details-process-row.tsx");
    const optional = modulePath("../components/assistant-panel-content-solid.tsx");
    const devices = modulePath("../pages/devices/devices-page.tsx");
    const cron = modulePath("../pages/cron/cron-page.tsx");
    const cronView = modulePath("../pages/cron/view.tsx");
    const cronDetail = modulePath("../pages/cron/view-detail.tsx");
    const cronRunLink = modulePath("../../../src/cron/run-link.ts");
    const cronDomain = modulePath("../lib/cron/index.ts");
    const cronForm = modulePath("../lib/cron/form.ts");
    const cronSchedule = modulePath("../lib/cron/form-schedule.ts");
    const cronModels = modulePath("../lib/cron/model-suggestions.ts");
    const modelRefs = modulePath(
      "../../../packages/model-catalog-core/src/configured-model-refs.ts",
    );
    const cronStyle = modulePath("../styles/cron.css");
    const cronPagination = modulePath("../components/cron-jobs-pagination.tsx");
    const agents = modulePath("../pages/agents/agents-page.tsx");
    const agentsCron = modulePath("../pages/agents/panel-cron.tsx");
    const templates = modulePath("../pages/templates/page.tsx");
    const creatorFlow = modulePath("../pages/templates/creator-flow.ts");
    const creatorPublication = modulePath("../pages/templates/creator-publication.ts");
    const security = modulePath("../pages/config/security.tsx");
    const uiToolCatalog = modulePath("../lib/agents/tool-catalog.ts");
    const coreToolCatalog = modulePath("../../../src/agents/tool-catalog.ts");
    const coreToolFacts = modulePath("../../../src/agents/core-tool-facts.ts");
    const automationsName = modulePath("../../../src/agents/tools/automations-tool-name.ts");
    const validator = modulePath("../../../packages/normalization-core/src/json-schema.ts");
    const sessions = modulePath("../pages/sessions/sessions-page.tsx");
    const welcomeCopy = modulePath("../i18n/locales/en-chat-welcome.ts");
    const peopleCopy = modulePath("../i18n/locales/en-session-people.ts");
    const hubHeader = modulePath("../components/solid/hub-page-header.tsx");
    const hubTabs = modulePath("../components/solid/hub-tabs.tsx");
    const hubStyle = modulePath("../styles/hub-tabs.css");
    const inlineHubStyle = `${hubStyle}?inline`;
    const settingsStyle = modulePath("../styles/settings.css");
    const styleOnly = modulePath("../pages/about/view.tsx");
    const tabs = modulePath("../components/solid/tabs.tsx");
    const tabState = modulePath("../lib/tabs.ts");
    const pendingFocus = modulePath("../lib/reactive/pending-focus.ts");
    const shadowStyles = modulePath("../lib/reactive/shadow-styles.ts");
    const tabsStyle = modulePath("../styles/tabs.css");
    const inlineTabsStyle = `${tabsStyle}?inline`;
    const settingsWorkspace = modulePath("../components/solid/settings-workspace.tsx");
    const settingsUi = modulePath("../components/solid/settings-ui.tsx");
    const settingsSelect = modulePath("../components/solid/settings-select.tsx");
    const routeSubtitles = modulePath("../i18n/locales/en-route-subtitles.ts");
    const talk = modulePath("../pages/talk/talk-page.tsx");
    const terminal = modulePath("../pages/terminal/terminal-page.tsx");
    const terminalRailStyle = modulePath("../styles/session-panel-rail.css");
    const terminalHelpers = [
      "../components/terminal/terminal-controller-lifecycle.ts",
      "../components/terminal/terminal-pending-actions.ts",
      "../components/terminal/terminal-session-storage.ts",
      "../components/terminal/terminal-tab-readiness.ts",
    ].map(modulePath);
    const skeleton = modulePath("../components/solid/panel-loading-skeleton.tsx");
    const skeletonStyle = `${modulePath("../styles/panel-loading-skeleton.css")}?inline`;
    const sharedUi = modulePath("../components/select-picker-view.tsx");
    const pluginActions = modulePath("../plugins/control-ui-actions.ts");
    const pluginLoader = modulePath("../plugins/control-ui-loader.ts");
    const inlineView = modulePath("../../../src/shared/plugin-inline-view.ts");
    const mutations = modulePath("../lib/sessions/session-mutation-operations.runtime.ts");
    const receipts = modulePath("../lib/sessions/session-patch-row-facts.ts");
    const creation = modulePath("../lib/sessions/create.ts");
    const unread = modulePath("../../../src/shared/session-unread.ts");
    const sharedStyle = modulePath("../styles/select-picker.css");
    const transcriptStyle = modulePath("../styles/chat/grouped.css");
    const sidebarStyle = modulePath("../styles/sidebar-reorder.css");
    const optionalStyle = modulePath("../components/kbd.css");
    const inlineStyle = `${optionalStyle}?inline`;
    const entry = "\0cold-load-fixture";
    const sources = new Map([
      [templates, `export { creator } from ${JSON.stringify(creatorFlow)};`],
      [creatorFlow, `export { owner as creator } from ${JSON.stringify(creatorPublication)};`],
      [creatorPublication, "export const owner = () => 'publication';"],
      [security, `export { catalog } from ${JSON.stringify(uiToolCatalog)};`],
      [
        uiToolCatalog,
        `import { catalog } from ${JSON.stringify(coreToolCatalog)}; import { name } from ${JSON.stringify(automationsName)}; export { catalog }; export const label = name;`,
      ],
      [
        coreToolCatalog,
        `import { facts } from ${JSON.stringify(coreToolFacts)}; import { name } from ${JSON.stringify(automationsName)}; export const catalog = facts + name;`,
      ],
      [
        coreToolFacts,
        `import { name } from ${JSON.stringify(automationsName)}; export const facts = name + 'facts';`,
      ],
      [automationsName, "export const name = 'automations';"],
      [meetings, `export { table } from ${JSON.stringify(markdownTables)};`],
      [
        markdownTables,
        `import { parked } from ${JSON.stringify(markdownBlockPresentation)}; import { display } from ${JSON.stringify(markdownLinkDisplay)}; export const table = () => parked() + display;`,
      ],
      [markdownBlockPresentation, "export const parked = () => false;"],
      [markdownLinkDisplay, "export const display = 'session-title';"],
      [
        usage,
        `import { format } from ${JSON.stringify(reactiveFormat)}; import { denied } from ${JSON.stringify(permissionError)}; export const render = () => format(denied());`,
      ],
      [reactiveFormat, "export const format = (value) => String(value);"],
      [
        permissionError,
        `import { copy } from ${JSON.stringify(permissionCopy)}; export const denied = () => copy;`,
      ],
      [permissionCopy, "export const copy = 'permission denied';"],
      [
        entry,
        `export const templates = () => import(${JSON.stringify(templates)}); export const security = () => import(${JSON.stringify(security)}); export const chat = () => import(${JSON.stringify(chat)}); export const usage = () => import(${JSON.stringify(usage)}); export const meetings = () => import(${JSON.stringify(meetings)}); export const newSession = () => import(${JSON.stringify(newSession)}); export const portals = () => import(${JSON.stringify(portals)}); export const devices = () => import(${JSON.stringify(devices)}); export const sessions = () => import(${JSON.stringify(sessions)}); export const cron = () => import(${JSON.stringify(cron)}); export const agents = () => import(${JSON.stringify(agents)}); export { validate } from ${JSON.stringify(validator)}; export const talk = () => import(${JSON.stringify(talk)}); export const styleOnly = () => import(${JSON.stringify(styleOnly)}); export const plugins = () => import(${JSON.stringify(pluginLoader)}); export const mutate = () => import(${JSON.stringify(mutations)});`,
      ],
      [
        chat,
        `import ${JSON.stringify(sharedStyle)}; import ${JSON.stringify(transcriptStyle)}; import { label } from ${JSON.stringify(sharedUi)}; import { action } from ${JSON.stringify(pluginActions)}; import { people } from ${JSON.stringify(peopleCopy)}; import { patch } from ${JSON.stringify(mutations)}; export { version } from ${JSON.stringify(inlineView)}; export { owner } from ${JSON.stringify(creatorPublication)}; export { facts } from ${JSON.stringify(coreToolFacts)}; export { parked } from ${JSON.stringify(markdownBlockPresentation)}; export { skeleton } from ${JSON.stringify(skeleton)}; export { poll } from ${JSON.stringify(visiblePoll)}; export { card } from ${JSON.stringify(permissionCard)}; export { row as process } from ${JSON.stringify(processRow)}; export { renderRun, renderPreview } from ${JSON.stringify(runFrame)}; export { format } from ${JSON.stringify(reactiveFormat)}; export { denied } from ${JSON.stringify(permissionError)}; export class Chat { label = patch(action(label + people)); } export const openPanel = () => import(${JSON.stringify(optional)});`,
      ],
      [
        newSession,
        `import ${JSON.stringify(sidebarStyle)}; import ${JSON.stringify(transcriptStyle)}; import { label } from ${JSON.stringify(sharedUi)}; import { welcome } from ${JSON.stringify(welcomeCopy)}; export class NewSession { label = label + welcome; }`,
      ],
      [
        runFrame,
        `import { stream } from ${JSON.stringify(runStream)}; import { preview } from ${JSON.stringify(sourcePreviews)}; export const renderRun = () => stream + preview; export const renderPreview = () => import(${JSON.stringify(sourcePreviewView)});`,
      ],
      [portals, `export { poll } from ${JSON.stringify(visiblePoll)};`],
      [visiblePoll, 'export const poll = () => "visible";'],
      [runStream, 'export const stream = "stream";'],
      [sourcePreviews, 'export const preview = "preview";'],
      [sourcePreviewView, 'export const view = "source-preview";'],
      [
        permissionCard,
        `import { permission } from ${JSON.stringify(permissionLabels)}; export const card = () => permission;`,
      ],
      [permissionLabels, 'export const permission = "permission";'],
      [processRow, 'export const row = "process";'],
      [
        optional,
        `import ${JSON.stringify(optionalStyle)}; import { hubTabs } from ${JSON.stringify(hubTabs)}; import { link } from ${JSON.stringify(settingsUi)}; import { subtitle } from ${JSON.stringify(routeSubtitles)}; export const panel = hubTabs() + link + subtitle;`,
      ],
      [devices, 'export const page = "devices-page";'],
      [
        sessions,
        `import { header } from ${JSON.stringify(hubHeader)}; import { workspace } from ${JSON.stringify(settingsWorkspace)}; import { select } from ${JSON.stringify(settingsSelect)}; import { welcome } from ${JSON.stringify(welcomeCopy)}; import { people } from ${JSON.stringify(peopleCopy)}; export function render() { return header() + workspace + select + welcome + people; }`,
      ],
      [
        hubHeader,
        `import { hubTabs } from ${JSON.stringify(hubTabs)}; import { link } from ${JSON.stringify(settingsUi)}; import { subtitle } from ${JSON.stringify(routeSubtitles)}; export function header() { return hubTabs() + link + subtitle; }`,
      ],
      [
        hubTabs,
        `import ${JSON.stringify(hubStyle)}; import css from ${JSON.stringify(inlineHubStyle)}; import { tabs } from ${JSON.stringify(tabs)}; export function hubTabs() { return tabs + css; }`,
      ],
      [
        tabs,
        `import ${JSON.stringify(tabsStyle)}; import css from ${JSON.stringify(inlineTabsStyle)}; import { tabState } from ${JSON.stringify(tabState)}; import { pendingFocus } from ${JSON.stringify(pendingFocus)}; import { shadowStyles } from ${JSON.stringify(shadowStyles)}; export const tabs = tabState + pendingFocus + shadowStyles + css;`,
      ],
      [tabsStyle, ".tabs-fixture { color: teal; }"],
      [inlineTabsStyle, ".tabs-fixture { color: teal; }"],
      [tabState, 'export const tabState = "state";'],
      [pendingFocus, 'export const pendingFocus = "focus";'],
      [shadowStyles, 'export const shadowStyles = "styles";'],
      [settingsUi, 'export const link = "learn-more";'],
      [hubStyle, ".hub-fixture { color: green; }"],
      [inlineHubStyle, ".hub-fixture { color: green; }"],
      [settingsStyle, ".settings-fixture { color: blue; }"],
      [styleOnly, `import ${JSON.stringify(settingsStyle)}; export const about = "about";`],
      [
        settingsWorkspace,
        `import ${JSON.stringify(settingsStyle)}; export const workspace = "workspace";`,
      ],
      [settingsSelect, 'export const select = "select";'],
      [routeSubtitles, 'export const subtitle = "route";'],
      [welcomeCopy, 'export const welcome = "welcome-copy";'],
      [peopleCopy, 'export const people = "people-copy";'],
      [cronRunLink, 'export const runLink = "run-link";'],
      [
        cron,
        `import { header } from ${JSON.stringify(hubHeader)}; import { workspace } from ${JSON.stringify(settingsWorkspace)}; import { view } from ${JSON.stringify(cronView)}; export { detail } from ${JSON.stringify(cronView)}; export function render() { return header() + workspace + view(); }`,
      ],
      [
        cronView,
        `import ${JSON.stringify(cronStyle)}; import { runLink } from ${JSON.stringify(cronRunLink)}; import { state } from ${JSON.stringify(cronDomain)}; import { models } from ${JSON.stringify(cronModels)}; import { pagination } from ${JSON.stringify(cronPagination)}; export function view() { return "overview" + runLink + state + models + pagination; } export const detail = () => import(${JSON.stringify(cronDetail)});`,
      ],
      [
        cronDomain,
        `import { form } from ${JSON.stringify(cronForm)}; import { schedule } from ${JSON.stringify(cronSchedule)}; export const state = form + schedule;`,
      ],
      [
        cronForm,
        `import { validate } from ${JSON.stringify(validator)}; export const form = validate;`,
      ],
      [cronSchedule, 'export const schedule = "schedule";'],
      [
        cronModels,
        `import { refs } from ${JSON.stringify(modelRefs)}; export const models = refs;`,
      ],
      [modelRefs, 'export const refs = "refs";'],
      [cronStyle, ".cron-fixture { color: maroon; }"],
      [cronPagination, 'export const pagination = "pagination";'],
      [validator, 'export const validate = "validate";'],
      [
        agents,
        `export { state } from ${JSON.stringify(cronDomain)}; export const panel = () => import(${JSON.stringify(agentsCron)});`,
      ],
      [agentsCron, `export { pagination } from ${JSON.stringify(cronPagination)};`],
      [cronDetail, 'export const detail = "lazy-editor";'],
      [talk, `export { skeleton } from ${JSON.stringify(skeleton)};`],
      [skeleton, `import css from ${JSON.stringify(skeletonStyle)}; export const skeleton = css;`],
      [skeletonStyle, ".skeleton-fixture { color: purple; }"],
      [sharedUi, `import inline from ${JSON.stringify(inlineStyle)}; export const label = inline;`],
      [pluginActions, "export const action = (label) => label;"],
      [
        pluginLoader,
        `export { action } from ${JSON.stringify(pluginActions)}; export { version } from ${JSON.stringify(inlineView)};`,
      ],
      [inlineView, "export const version = (value) => Number.isInteger(value);"],
      [
        mutations,
        `export { patch } from ${JSON.stringify(receipts)}; export { create } from ${JSON.stringify(creation)};`,
      ],
      [creation, "export const create = () => 'created';"],
      [receipts, `export { patch } from ${JSON.stringify(unread)};`],
      [unread, "export const patch = (value) => value;"],
      [sharedStyle, ".shared-fixture { color: red; }"],
      [transcriptStyle, ".transcript-fixture { color: green; }"],
      [sidebarStyle, ".sidebar-fixture { color: blue; }"],
      [optionalStyle, ".optional-fixture { color: orange; }"],
      [inlineStyle, ".optional-fixture { color: orange; }"],
    ]);
    const sharedHelpers = ["../components/solid/markdown-html.tsx", "../lib/text-diff.ts"].map(
      modulePath,
    );
    const helperPage = "\0helper-only-route";
    for (const [page, helpers, prefix, name, value] of [
      [helperPage, sharedHelpers, "helper", "helpers", "shared"],
      [terminal, terminalHelpers, "terminal", "terminal", "terminal-owner"],
    ] as const) {
      const imports = helpers
        .map((id, index) => `export { helper as ${prefix}${index} } from ${JSON.stringify(id)};`)
        .join("\n");
      for (const id of helpers) {
        sources.set(id, `export const helper = '${value}';`);
      }
      sources.set(page, imports);
      sources.set(chat, sources.get(chat)! + imports);
      sources.set(
        entry,
        sources.get(entry)! + `export const ${name} = () => import(${JSON.stringify(page)});`,
      );
    }
    sources.set(terminalRailStyle, ".terminal-rail-fixture { color: cyan; }");
    sources.set(terminal, `import ${JSON.stringify(terminalRailStyle)}; ${sources.get(terminal)}`);
    sources.set(chat, sources.get(chat)! + `import ${JSON.stringify(terminalRailStyle)};`);
    const result = await buildFixture(entry, sources, {
      ...controlUiCodeSplitting,
      // A stale capture must not pull a lazy page into the shared boot chunk.
      groups: controlUiCodeSplitting.groups.map((group) => ({
        ...group,
        // Exercise grouping below the production chunk-size floor.
        minSize: 0,
        ...(group.name === "control-ui-boot-chat"
          ? { test: (id: string) => sharedHelpers.includes(id) || group.test(id) }
          : {}),
        ...(group.name === "control-ui-boot-shared"
          ? {
              // Fixture sharing is independent of changing production captures.
              test: (id: string) =>
                [
                  devices,
                  sharedUi,
                  sharedStyle,
                  sidebarStyle,
                  mutations,
                  receipts,
                  creation,
                  unread,
                ].includes(id) || group.test(id),
            }
          : {}),
        ...(group.name === "control-ui-boot-shared-styles"
          ? {
              test: (id: string) => id === sharedStyle || id === sidebarStyle || group.test(id),
            }
          : {}),
      })),
    });
    if (Array.isArray(result) || !("output" in result)) {
      throw new Error("Expected one in-memory build");
    }
    const styles = result.output
      .filter((asset) => asset.type === "asset")
      .filter((asset) => asset.fileName.endsWith(".css"));
    expect(styles).toHaveLength(5);
    const sharedStyles = styles.find((style) => String(style.source).includes(".shared-fixture"));
    for (const selector of ["sidebar", "transcript", "terminal-rail"]) {
      expect(sharedStyles).toMatchObject({
        source: expect.stringContaining(`.${selector}-fixture`),
      });
    }
    expect(sharedStyles?.source).not.toContain(".optional-fixture");
    expect(sharedStyles?.source).not.toContain(".tabs-fixture");
    const routeStyles = styles.find((style) => String(style.source).includes(".settings-fixture"));
    expect(routeStyles?.source).toContain(".hub-fixture");
    expect(routeStyles?.source).not.toContain(".tabs-fixture");
    const chunks = result.output.filter((asset) => asset.type === "chunk");
    const chunkFor = (id: string) => chunks.find((chunk) => id in chunk.modules)!;
    const entryChunk = chunks.find((chunk) => chunk.isEntry)!;
    const chatChunk = chunkFor(chat);
    const newSessionChunk = chunkFor(newSession);
    const staticImports = importClosure(
      (file) => chunks.find((chunk) => chunk.fileName === file)!.imports,
    );
    expect(staticImports(chatChunk.fileName)).not.toContain(newSessionChunk.fileName);
    expect(staticImports(newSessionChunk.fileName)).not.toContain(chatChunk.fileName);
    const markdownChunk = chunkFor(markdownTables);
    const meetingsChunk = chunkFor(meetings);
    expect(staticImports(markdownChunk.fileName)).not.toContain(chatChunk.fileName);
    expect(staticImports(meetingsChunk.fileName)).toContain(markdownChunk.fileName);
    expect(staticImports(meetingsChunk.fileName)).not.toContain(chatChunk.fileName);
    expect(staticImports(entryChunk.fileName)).not.toContain(markdownChunk.fileName);
    const startup = staticImports(entryChunk.fileName);
    const displayChunk = chunkFor(markdownLinkDisplay);
    expect(staticImports(meetingsChunk.fileName)).toContain(displayChunk.fileName);
    expect(startup).not.toContain(displayChunk.fileName);
    for (const [page, helpers] of [
      [templates, [creatorPublication]],
      [security, [coreToolFacts, automationsName]],
      [helperPage, sharedHelpers],
      [terminal, terminalHelpers],
    ] as const) {
      const pageChunk = chunkFor(page);
      const imports = staticImports(pageChunk.fileName);
      expect(imports).not.toContain(chatChunk.fileName);
      expect(imports).not.toContain(newSessionChunk.fileName);
      expect(startup).not.toContain(pageChunk.fileName);
      for (const helper of helpers) {
        const chunk = chunkFor(helper);
        expect(imports).toContain(chunk.fileName);
        expect(startup).not.toContain(chunk.fileName);
      }
    }
    const sessionsChunk = chunkFor(sessions);
    expect(staticImports(sessionsChunk.fileName)).not.toContain(chatChunk.fileName);
    expect(staticImports(sessionsChunk.fileName)).not.toContain(newSessionChunk.fileName);
    const runChunk = chunkFor(runFrame);
    expect([runStream, sourcePreviews].every((id) => id in runChunk.modules)).toBe(true);
    expect(staticImports(chatChunk.fileName)).toContain(runChunk.fileName);
    expect(staticImports(newSessionChunk.fileName)).not.toContain(runChunk.fileName);
    const previewChunk = chunkFor(sourcePreviewView);
    expect(staticImports(chatChunk.fileName)).not.toContain(previewChunk.fileName);
    expect(runChunk.dynamicImports).toContain(previewChunk.fileName);
    const visibleChunk = chunkFor(permissionCard);
    expect([permissionLabels, processRow].every((id) => id in visibleChunk.modules)).toBe(true);
    expect(staticImports(chatChunk.fileName)).toContain(visibleChunk.fileName);
    expect(staticImports(visibleChunk.fileName)).not.toContain(runChunk.fileName);
    const pluginChunk = chunkFor(pluginLoader);
    const usageChunk = chunkFor(usage);
    const formatChunk = chunkFor(reactiveFormat);
    expect([permissionError, permissionCopy].every((id) => id in formatChunk.modules)).toBe(true);
    expect(staticImports(usageChunk.fileName)).toContain(formatChunk.fileName);
    expect(staticImports(usageChunk.fileName)).not.toContain(chatChunk.fileName);
    const actionChunk = chunkFor(pluginActions);
    const sharedChunk = chunkFor(sharedUi);
    expect(actionChunk.fileName).toBe(sharedChunk.fileName);
    expect(staticImports(pluginChunk.fileName)).toContain(actionChunk.fileName);
    expect(staticImports(pluginChunk.fileName)).not.toContain(chatChunk.fileName);
    const portalsChunk = chunkFor(portals);
    const pollChunk = chunkFor(visiblePoll);
    expect(pollChunk.fileName).toBe(sharedChunk.fileName);
    expect(staticImports(portalsChunk.fileName)).toContain(pollChunk.fileName);
    expect(staticImports(portalsChunk.fileName)).not.toContain(chunkFor(skeleton).fileName);
    expect(staticImports(entryChunk.fileName)).not.toContain(pollChunk.fileName);
    const cronChunk = chunkFor(cron);
    const cronDetailChunk = chunkFor(cronDetail);
    expect(cronView in cronChunk.modules).toBe(true);
    expect(cronRunLink in cronChunk.modules).toBe(true);
    expect([cronModels, modelRefs].every((id) => id in cronChunk.modules)).toBe(true);
    const domainChunk = chunkFor(cronDomain);
    expect(domainChunk.fileName).toContain("cron-domain");
    expect([cronForm, cronSchedule].every((id) => id in domainChunk.modules)).toBe(true);
    expect(staticImports(cronChunk.fileName)).toContain(domainChunk.fileName);
    expect(staticImports(entryChunk.fileName)).not.toContain(domainChunk.fileName);
    const agentsChunk = chunkFor(agents);
    expect(staticImports(agentsChunk.fileName)).toContain(domainChunk.fileName);
    expect(staticImports(agentsChunk.fileName)).not.toContain(cronChunk.fileName);
    const paginationChunk = chunkFor(cronPagination);
    expect(staticImports(agentsChunk.fileName)).not.toContain(paginationChunk.fileName);
    expect(staticImports(chunkFor(agentsCron).fileName)).toContain(paginationChunk.fileName);
    expect(cronDetailChunk.fileName).not.toBe(cronChunk.fileName);
    expect(staticImports(cronChunk.fileName)).not.toContain(cronDetailChunk.fileName);
    expect(cronChunk.dynamicImports).toContain(cronDetailChunk.fileName);
    expect(staticImports(entryChunk.fileName)).not.toContain(cronChunk.fileName);
    expect(staticImports(chatChunk.fileName)).not.toContain(cronChunk.fileName);
    const chromeChunk = chunkFor(hubHeader);
    const styleOnlyChunk = chunkFor(styleOnly);
    expect(staticImports(styleOnlyChunk.fileName)).not.toContain(chromeChunk.fileName);
    expect(staticImports(styleOnlyChunk.fileName)).not.toContain(chunkFor(hubTabs).fileName);
    expect([settingsWorkspace, settingsSelect].every((id) => id in chromeChunk.modules)).toBe(true);
    const tabsChunk = chunkFor(tabs);
    expect([tabState, shadowStyles, inlineTabsStyle].every((id) => id in tabsChunk.modules)).toBe(
      true,
    );
    expect([hubTabs, pendingFocus].some((id) => id in tabsChunk.modules)).toBe(false);
    for (const initial of [entryChunk, chatChunk, newSessionChunk]) {
      expect(staticImports(initial.fileName)).not.toContain(tabsChunk.fileName);
    }
    for (const route of [sessions, cron]) {
      const routeChunk = chunkFor(route);
      expect(staticImports(routeChunk.fileName)).toContain(chromeChunk.fileName);
      expect(staticImports(entryChunk.fileName)).not.toContain(routeChunk.fileName);
      expect(routeChunk.fileName).not.toBe(chromeChunk.fileName);
    }
    expect(staticImports(entryChunk.fileName)).not.toContain(chromeChunk.fileName);
    expect(staticImports(chatChunk.fileName)).not.toContain(chromeChunk.fileName);
    expect(staticImports(newSessionChunk.fileName)).not.toContain(chromeChunk.fileName);
    expect(staticImports(entryChunk.fileName)).not.toContain(actionChunk.fileName);
    const mutationChunk = chunkFor(mutations);
    expect(staticImports(entryChunk.fileName)).not.toContain(mutationChunk.fileName);
    expect(staticImports(mutationChunk.fileName)).not.toContain(chatChunk.fileName);
    expect(staticImports(mutationChunk.fileName)).not.toContain(sharedChunk.fileName);
    const devicesChunk = chunkFor(devices);
    const talkChunk = chunkFor(talk);
    expect(staticImports(talkChunk.fileName)).not.toContain(chatChunk.fileName);
    expect(staticImports(talkChunk.fileName)).not.toContain(newSessionChunk.fileName);
    expect(staticImports(chatChunk.fileName)).not.toContain(devicesChunk.fileName);
    expect(staticImports(newSessionChunk.fileName)).not.toContain(devicesChunk.fileName);
    const deferred = chunkFor(optional);
    expect(deferred).toBeDefined();
    expect(staticImports(deferred.fileName)).not.toContain(chromeChunk.fileName);
    expect(chunks.filter((chunk) => chunk.imports.includes(deferred.fileName))).toHaveLength(0);
  });

  it("keeps optional runtime dependencies separate from initial modules", () => {
    expect(controlUiCodeSplitting.includeDependenciesRecursively).toBe(false);
    expect(
      controlUiCodeSplitting.groups.find((group) => group.name === "control-ui-core"),
    ).toMatchObject({
      tags: ["$initial"],
    });
    for (const [id, expected] of [
      ["/repo/ui/node_modules/highlight.js/lib/core.js", "markdown-highlight-runtime"],
      ["/repo/ui/node_modules/markdown-it/dist/markdown-it.mjs", "markdown-runtime"],
      ["/repo/ui/node_modules/entities/dist/esm/index.js", "markdown-runtime"],
      ["/repo/ui/node_modules/linkify-it/build/index.cjs.js", "markdown-runtime"],
      ["/repo/ui/node_modules/mdurl/index.mjs", "markdown-runtime"],
      ["/repo/ui/node_modules/punycode.js/punycode.es6.js", "markdown-runtime"],
      ["/repo/ui/node_modules/uc.micro/index.mjs", "markdown-runtime"],
      [String.raw`C:\repo\ui\node_modules\highlight.js\lib\core.js`, "markdown-highlight-runtime"],
      ["/tmp/openclaw-pnpm-node-modules/dompurify/dist/purify.es.mjs", "markdown-runtime"],
      ["/tmp/openclaw-pnpm-node-modules/zod/v4/core/schemas.js", "config-runtime"],
      ["/tmp/openclaw-pnpm-node-modules/json5/dist/index.js", "json5-runtime"],
      [
        "/tmp/openclaw-pnpm-node-modules/libphonenumber-js/max/exports/parsePhoneNumber.js",
        "phone-runtime",
      ],
      ["/tmp/openclaw-pnpm-node-modules/@noble/ed25519/index.js", "device-signing-runtime"],
      ["/repo/ui/src/lib/gateway-methods.ts", undefined],
      [modulePath("../components/sidebar-update-card.tsx"), "sidebar-update-runtime"],
      [modulePath("../styles/sidebar-update-card.css"), "sidebar-update-runtime"],
      [modulePath("../pages/chat/route-entry.ts"), "chat-route-entry"],
      [modulePath("../pages/cron/cron-page.tsx"), "cron-page"],
      [modulePath("../pages/plugins/plugins-page.tsx"), "plugins-page"],
      [modulePath("../components/markdown-parser.ts"), "markdown-runtime"],
      [modulePath("../components/config-form.shared.ts"), "config-form-analysis-runtime"],
      [modulePath("../components/cloud-profile-icon-data.ts"), "route-controls-runtime"],
      [modulePath("../components/solid/cloud-profile-icon.tsx"), "route-controls-runtime"],
      ["/repo/ui/src/lib/clipboard.ts", undefined],
      ["/repo/ui/src/build-info.ts", undefined],
      ["/repo/ui/src/build-info-normalizers.ts", undefined],
      ["/repo/ui/src/app/app-host.tsx", undefined],
      ["\0virtual:openclaw-control-ui-locale-config-hints/ru", "locale-config-hints-ru"],
      ["\0virtual:openclaw-control-ui-locale/ru", undefined],
    ] as const) {
      expect(controlUiStableChunkName(id), id).toBe(expected);
    }
  });

  it("lets snapshot prewarming load independently of the measured boot groups", () => {
    const database = modulePath("../pages/chat/session-snapshot-database.ts");
    const stableGroup = controlUiCodeSplitting.groups.find(
      (group) =>
        typeof group.name === "function" && group.name(database) === "session-snapshot-database",
    );
    const bootGroup = controlUiCodeSplitting.groups.find(
      (group) =>
        typeof group.name === "string" &&
        /^control-ui-boot-(?:shared|new|chat)$/u.test(group.name) &&
        group.test?.(database),
    )!;

    expect(bootGroup).toBeDefined();
    expect(stableGroup?.test?.(database)).toBe(true);
    expect(controlUiStableChunkName(database)).toBe("session-snapshot-database");
    expect(stableGroup?.priority).toBeGreaterThan(bootGroup.priority);
  });

  it("consolidates shared boot without pulling in the chat route or optional panels", () => {
    // Recursive inclusion is a correctness requirement for this group: merging
    // the lazy boot graph without it emitted chunks whose execution order broke
    // at application start.
    const sharedGroup = controlUiCodeSplitting.groups.find(
      (group) => group.name === "control-ui-boot-shared",
    );
    expect(sharedGroup).toMatchObject({ includeDependenciesRecursively: true });
    const bootGroup = sharedGroup as {
      test: (id: string) => boolean;
    };
    const repoRoot = modulePath("../../..").replace(/\/$/, "");
    // Representative always-loaded boot surface and a lazy island that must
    // keep its own chunk (terminal runtime is not part of the default boot).
    expect(bootGroup.test(`${repoRoot}/ui/src/components/app-sidebar.tsx`)).toBe(true);
    // Chat reaches narration through a dynamic import without a request of its own.
    expect(bootGroup.test(`${repoRoot}/ui/src/components/app-sidebar-session-narration.ts`)).toBe(
      true,
    );
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/chat/chat-page.tsx`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/cron/cron-page.tsx`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/plugins/plugins-page.tsx`)).toBe(false);
    // Fetched shared chunks once co-located the chat view with modules New Session needs.
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/chat/chat-view.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/styles/chat.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/components/assistant-panel-content-solid.tsx`)).toBe(
      false,
    );
    // Opening state stays cheap; rendering the debug overlay belongs to its lazy graph.
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay-state.ts`)).toBe(true);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay-content.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay-frame.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/ui/src/pages/debug/debug-overlay-loading.ts`)).toBe(false);
    expect(bootGroup.test(`${repoRoot}/node_modules/ghostty-web/dist/index.js`)).toBe(false);
  });

  it("derives stable manifest keys across pnpm layouts and platforms", () => {
    expect(
      controlUiBootManifestKey(
        "/repo/node_modules/.pnpm/nanoid@5.0.0/node_modules/nanoid/index.browser.js",
      ),
    ).toBe("node_modules/nanoid/index.browser.js");
    expect(
      controlUiBootManifestKey(
        "/repo/node_modules/@example/control/node_modules/nanoid/index.browser.js",
      ),
    ).toBe("node_modules/nanoid/index.browser.js");
    expect(controlUiBootManifestKey("/repo/ui/src/main.ts?html-proxy&index=0.js")).not.toContain(
      "?",
    );
    expect(controlUiBootManifestKey(String.raw`C:\repo\node_modules\nanoid\index.browser.js`)).toBe(
      "node_modules/nanoid/index.browser.js",
    );
  });
});
