import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createStore } from "solid-js";
import type {
  SkillLibraryEntry,
  SkillLibraryFile,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
  SkillsLibraryMutateParams,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { assertUploadsEnabled, uploadsEnabled } from "../../lib/uploads.ts";
import { readLibraryFiles, uploadLibraryArchive } from "./library-files.ts";
import { observeSkillState } from "./observe-state.ts";

export type LibraryView = "workspace" | "mine" | "team" | "all";
export type LibraryDraft = {
  importedFiles?: boolean;
  entry: SkillLibraryEntry | null;
  slug: string;
  content: string;
  files: readonly Readonly<SkillLibraryFile>[];
  baseFiles: readonly Readonly<SkillLibraryFile>[];
  revisions: SkillsLibraryReadResult["revisions"];
  selectedFile: string;
  rollbackRevision: string;
  dirty: boolean;
};

function libraryDraft(read?: SkillsLibraryReadResult): LibraryDraft {
  return {
    entry: read ? read.entry : null,
    slug: read ? read.entry.slug : "",
    content: read ? read.content : "",
    files: read ? read.files : [],
    baseFiles: read ? read.files : [],
    revisions: read ? read.revisions : [],
    selectedFile: "SKILL.md",
    rollbackRevision: "",
    dirty: false,
  };
}

export function createSkillLibrary(
  gateway: {
    readonly snapshot: ApplicationGatewaySnapshot | null;
    capture(): GatewayConnectionScope | null;
    isCurrent(scope: GatewayConnectionScope): boolean;
  },
  config: () => ApplicationConfigCapability | undefined = () => undefined,
) {
  // Drafts and write admission stay synchronous; Solid only observes the owner.
  const observation = observeSkillState<{
    list: SkillsLibraryListResult | null;
    view: LibraryView | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    notice: string | null;
    draft: LibraryDraft | null;
    importSlug: string;
    importSource: { slug: string; version?: string } | null;
    importSelection: File[];
  }>({
    list: null,
    view: null,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    draft: null,
    importSlug: "",
    importSource: null,
    importSelection: [],
  });
  const data = observation.state;
  const [local, setLocal] = createStore({ importOpen: false, newFilePath: "", query: "" });
  function clearFeedback() {
    data.error = null;
    data.notice = null;
  }
  function setImportOpen(visible: boolean) {
    clearFeedback();
    setLocal((state) => {
      state.importOpen = visible;
    });
    if (!visible) {
      data.importSlug = "";
      data.importSource = null;
      data.importSelection = [];
    }
  }
  function showWorkspace() {
    const view = observation.read().view;
    return view === null || view === "workspace";
  }
  function canWrite() {
    return canCallGatewayMethod(gateway.snapshot, "skills.library.save", "operator.write", {
      requireAdvertisement: false,
    });
  }
  function canTransfer() {
    return canCallGatewayMethod(gateway.snapshot, "skills.library.mutate", "operator.admin", {
      requireAdvertisement: false,
    });
  }
  function canCreate() {
    const state = observation.read();
    return !state.loading && Boolean(state.list?.profileId) && canWrite();
  }
  function canEdit() {
    return canWrite() && (observation.read().draft?.entry?.canEdit ?? true);
  }

  async function load(snapshot = gateway.snapshot) {
    const connection = gateway.capture();
    if (
      !connection ||
      data.loading ||
      !canCallGatewayMethod(snapshot, "skills.library.list", "operator.read", {
        requireAdvertisement: false,
      })
    ) {
      return;
    }
    data.loading = true;
    data.error = null;
    try {
      const result = await connection.client.request<SkillsLibraryListResult>(
        "skills.library.list",
        { scope: "all" },
      );
      if (!gateway.isCurrent(connection)) {
        return;
      }
      data.list = result;
      data.view ??= result.defaultTarget === "personal" ? "mine" : "workspace";
    } catch (error) {
      if (gateway.isCurrent(connection)) {
        data.error = formatUiError(error);
      }
    } finally {
      if (gateway.isCurrent(connection)) {
        data.loading = false;
      }
    }
  }

  function create() {
    const connection = gateway.capture();
    if (!connection || !canCreate()) {
      return;
    }
    data.draft = libraryDraft();
    clearFeedback();
    setLocal((state) => {
      state.newFilePath = "";
    });
  }

  async function perform(action: (connection: GatewayConnectionScope) => Promise<void>) {
    if (data.busy || data.loading) {
      return;
    }
    const connection = gateway.capture();
    if (!connection) {
      data.error = t("skillLibrary.connectionChanged");
      return;
    }
    data.busy = true;
    clearFeedback();
    try {
      await action(connection);
    } catch (error) {
      if (gateway.isCurrent(connection)) {
        const code =
          error instanceof GatewayRequestError ? asNullableRecord(error.details)?.code : undefined;
        data.error =
          code === "SKILL_LIBRARY_CONFLICT"
            ? t("skillLibrary.conflict")
            : code === "SKILL_LIBRARY_IDENTITY_REQUIRED"
              ? t("skillLibrary.signIn")
              : formatUiError(error);
      }
    } finally {
      if (gateway.isCurrent(connection)) {
        data.busy = false;
      }
    }
  }

  async function recordReceipt(receipt: SkillsLibraryReceipt) {
    data.notice =
      t(`skillLibrary.receipt.${receipt.state}`, {
        slug: receipt.entry.slug,
        target: receipt.target,
        owner: receipt.entry.ownerLabel,
      }) +
      " " +
      receipt.nextAction;
    await load();
  }

  return {
    get state() {
      return observation.read();
    },
    local,
    setLocal,
    edit: observation.edit,
    setImportOpen,
    showWorkspace,
    uploadsEnabled: () => uploadsEnabled(config()),
    canWrite,
    canTransfer,
    canCreate,
    canEdit,
    load,
    ensureLoaded(snapshot: ApplicationGatewaySnapshot | null) {
      if (!data.list && !data.loading && !data.error) {
        void load(snapshot);
      }
    },
    create,
    invalidateRequests() {
      data.loading = false;
      data.busy = false;
    },
    reset() {
      clearFeedback();
      data.list = null;
      data.view = null;
      data.loading = false;
      data.busy = false;
      data.draft = null;
      setImportOpen(false);
      setLocal((state) => {
        state.newFilePath = "";
        state.query = "";
      });
    },
    close() {
      if (data.busy || (data.draft?.dirty && !window.confirm(t("skillLibrary.discard")))) {
        return;
      }
      data.draft = null;
      setImportOpen(false);
      setLocal((state) => {
        state.newFilePath = "";
      });
    },
    async open(skillId: string) {
      if (data.draft?.dirty && !window.confirm(t("skillLibrary.discard"))) {
        return;
      }
      const connection = gateway.capture();
      if (!connection || data.busy) {
        return;
      }
      await perform(async () => {
        const read = await connection.client.request<SkillsLibraryReadResult>(
          "skills.library.read",
          {
            skillId,
          },
        );
        if (!gateway.isCurrent(connection)) {
          return;
        }
        data.draft = libraryDraft(read);
      });
    },
    async save() {
      const draft = data.draft;
      if (!draft || !canEdit()) {
        return;
      }
      await perform(async (connection) => {
        if (draft.importedFiles) {
          assertUploadsEnabled(config());
        }
        const client = connection.client;
        const savedFiles = draft.files;
        const baseFiles = new Map(draft.baseFiles.map((file) => [file.path, file]));
        const retainFiles: string[] = [];
        const files = savedFiles.filter((file) => {
          const base = draft.entry ? baseFiles.get(file.path) : undefined;
          if (
            base &&
            base.content === file.content &&
            base.encoding === file.encoding &&
            base.executable === file.executable
          ) {
            retainFiles.push(file.path);
            return false;
          }
          return true;
        });
        if (files.length) {
          assertUploadsEnabled(config());
        }
        const receipt = await client.request<SkillsLibraryReceipt>("skills.library.save", {
          ...(draft.entry ? { skillId: draft.entry.skillId } : {}),
          expectedRevision: draft.entry?.revision ?? null,
          slug: draft.slug,
          content: draft.content,
          files,
          ...(retainFiles.length ? { retainFiles } : {}),
        });
        if (!gateway.isCurrent(connection)) {
          return;
        }
        draft.entry = receipt.entry;
        draft.baseFiles = savedFiles;
        draft.importedFiles = false;
        draft.dirty = false;
        draft.revisions = [
          { revision: receipt.entry.revision, createdAt: receipt.entry.updatedAt },
          ...draft.revisions.filter((item) => item.revision !== receipt.entry.revision),
        ];
        await recordReceipt(receipt);
      });
    },
    async mutate(action: SkillsLibraryMutateParams["action"]) {
      const draft = data.draft;
      const entry = draft?.entry;
      if (!draft || !entry || !canEdit() || draft.dirty) {
        return;
      }
      if (
        (action === "remove" || action === "transfer") &&
        !window.confirm(t(`skillLibrary.confirm.${action}`, { slug: draft.slug }))
      ) {
        return;
      }
      await perform(async (connection) => {
        const receipt = await connection.client.request<SkillsLibraryReceipt>(
          "skills.library.mutate",
          {
            skillId: entry.skillId,
            expectedRevision: entry.revision,
            action,
            ...(action === "rollback" ? { revision: draft.rollbackRevision } : {}),
          },
        );
        if (!gateway.isCurrent(connection)) {
          return;
        }
        if (action === "remove") {
          data.draft = null;
        }
        // Record the committed mutation even if the follow-up list or revision read fails.
        await recordReceipt(receipt);
        if (action === "remove") {
          return;
        }
        if (action === "rollback") {
          const read = await connection.client.request<SkillsLibraryReadResult>(
            "skills.library.read",
            { skillId: receipt.entry.skillId, revision: receipt.entry.revision },
          );
          if (!gateway.isCurrent(connection)) {
            return;
          }
          draft.content = read.content;
          draft.files = read.files;
          draft.baseFiles = read.files;
          draft.revisions = read.revisions;
          draft.selectedFile = "SKILL.md";
          draft.rollbackRevision = "";
        }
        draft.entry = receipt.entry;
      });
    },
    async importFiles(files: File[]) {
      if (!files.length) {
        return;
      }
      const connection = gateway.capture();
      if (!connection) {
        return;
      }
      await perform(async () => {
        assertUploadsEnabled(config());
        const [file] = files;
        if (file && files.length === 1 && file.name.toLowerCase().endsWith(".zip")) {
          if (!data.list?.profileId) {
            throw new Error(t("skillLibrary.signIn"));
          }
          const receipt = await uploadLibraryArchive(
            connection.client,
            file,
            data.importSlug,
            () => gateway.isCurrent(connection),
            config(),
          );
          if (gateway.isCurrent(connection)) {
            setImportOpen(false);
            await recordReceipt(receipt);
          }
          return;
        }
        const bundle = await readLibraryFiles(files, config());
        assertUploadsEnabled(config());
        if (!gateway.isCurrent(connection)) {
          return;
        }
        create();
        if (data.draft) {
          Object.assign(data.draft, bundle, {
            slug: data.importSlug,
            dirty: true,
            importedFiles: true,
          });
          setImportOpen(false);
        }
      });
    },
    async importClawHub(slug: string, sourceSlug: string, version?: string) {
      const connection = gateway.capture();
      if (!connection || !data.list?.profileId || !canWrite()) {
        return;
      }
      await perform(async () => {
        const receipt = await connection.client.request<SkillsLibraryReceipt>(
          "skills.library.import",
          { slug, source: { kind: "clawhub", slug: sourceSlug, ...(version ? { version } : {}) } },
        );
        if (gateway.isCurrent(connection)) {
          setImportOpen(false);
          await recordReceipt(receipt);
        }
      });
    },
  };
}

export type SkillLibraryModel = ReturnType<typeof createSkillLibrary>;
