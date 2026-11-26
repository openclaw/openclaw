import { builtinDeveloperProfiles } from "../../../../src/shared/dictation-developer-builtins.ts";
import {
  DeveloperProfileRegistry,
  parseDeveloperProfile,
} from "../../../../src/shared/dictation-developer-profiles.ts";
import type {
  DeveloperPlan,
  DeveloperProfile,
} from "../../../../src/shared/dictation-developer-types.ts";
import { createDeveloperPlan } from "../../../../src/shared/dictation-developer.ts";
import { applyDictationPlan } from "../../../../src/shared/dictation-refinement.ts";
import {
  DEFAULT_DEVELOPER_DICTATION_SETTINGS,
  DEVELOPER_DICTATION_MAX_PROFILES,
  normalizeDeveloperDictationSettings,
  type DeveloperDictationSettings,
} from "../../app/settings-developer-dictation.ts";
import { t } from "../../i18n/index.ts";
import { registerChatDictationEnglish } from "../../i18n/locales/en-chat-dictation.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { DeveloperDictationTarget } from "./composer-developer-target.ts";
import type { ComposerDictationReviewCapture } from "./composer-dictation.ts";

registerChatDictationEnglish();

type Review = {
  id: number;
  phase: "capturing" | "review";
  target: DeveloperDictationTarget;
  settings: DeveloperDictationSettings;
  configuration: string;
  profile: DeveloperProfile | undefined;
  raw: string;
  choices: Record<string, string>;
  omitted: Set<string>;
  original: boolean;
  plan: DeveloperPlan | null;
  text: string | null;
};

/** Local presentation/preparation only; the existing capture owner delivers FIFO finals. */
export class ComposerDeveloperSyntax extends EventTarget {
  private generation = 0;
  private current: Review | null = null;
  private rawSettings: unknown;
  private registry = new DeveloperProfileRegistry();
  private configError = false;
  private explicitProseFallback = false;
  settings = DEFAULT_DEVELOPER_DICTATION_SETTINGS;
  notice = "";

  constructor(
    private options: {
      readSettings(): unknown;
      saveSettings(value: DeveloperDictationSettings): void;
      captureTarget(): DeveloperDictationTarget | undefined;
      cancelCapture(): void;
      copy(text: string): Promise<void>;
    },
  ) {
    super();
    this.refreshSettings();
  }

  subscribe(listener: () => void) {
    return listen(this, "change", listener);
  }

  update(options: typeof this.options) {
    this.options = options;
  }

  get profiles() {
    return this.registry.profiles;
  }
  get invalidSettings() {
    return this.configError;
  }
  get review() {
    return this.current?.phase === "review" ? this.current : null;
  }
  get blocksSend() {
    return this.current !== null;
  }
  get targetCurrent() {
    return !this.current || this.isCurrent(this.current);
  }
  get canAccept() {
    const review = this.review;
    return (
      review !== null &&
      review.text !== null &&
      review.target.canInsertExact?.(review.text) !== false
    );
  }
  get canCopy() {
    return this.review?.text !== null && this.review !== null;
  }

  private changed() {
    this.dispatchEvent(new Event("change"));
  }

  private refreshSettings() {
    this.rawSettings = this.options.readSettings();
    const settings =
      this.rawSettings === undefined
        ? DEFAULT_DEVELOPER_DICTATION_SETTINGS
        : normalizeDeveloperDictationSettings(this.rawSettings);
    this.configError = !settings;
    this.settings = settings ?? DEFAULT_DEVELOPER_DICTATION_SETTINGS;
    const authored: DeveloperProfile[] = [];
    const seen = new Set<string>();
    for (const profile of this.settings.profiles) {
      const parsed = parseDeveloperProfile(profile);
      if (!parsed.ok || seen.has(parsed.profile.id)) {
        this.configError = true;
        break;
      }
      seen.add(parsed.profile.id);
      authored.push(parsed.profile);
    }
    this.registry = new DeveloperProfileRegistry([...builtinDeveloperProfiles, ...authored]);
  }

  configure(
    patch: Partial<Pick<DeveloperDictationSettings, "enabled" | "mode" | "locale" | "profileId">>,
  ) {
    this.refreshSettings();
    if (this.configError) {
      this.notice = t("chat.dictation.developer.invalidSettings");
      this.changed();
      return;
    }
    this.cancel();
    this.options.saveSettings({ ...this.settings, ...patch });
    this.refreshSettings();
    this.changed();
  }

  importProfile(json: string): boolean {
    this.refreshSettings();
    if (this.configError) {
      return false;
    }
    const registry = new DeveloperProfileRegistry(this.registry.profiles);
    const parsed = parseDeveloperProfile(json);
    const result = parsed.ok
      ? registry.import(json, registry.get(parsed.profile.id)?.revision)
      : parsed;
    if (!result.ok) {
      this.notice = t("chat.dictation.developer.importFailed");
      this.changed();
      return false;
    }
    const authored = this.settings.profiles.filter((saved) => {
      const savedProfile = parseDeveloperProfile(saved);
      return !savedProfile.ok || savedProfile.profile.id !== result.profile.id;
    });
    if (authored.length >= DEVELOPER_DICTATION_MAX_PROFILES) {
      this.notice = t("chat.dictation.developer.profileLimit");
      this.changed();
      return false;
    }
    this.cancel();
    this.options.saveSettings({
      ...this.settings,
      profileId: result.profile.id,
      locale: result.profile.locale,
      profiles: [...authored, json],
    });
    this.refreshSettings();
    this.notice = t("chat.dictation.developer.imported");
    this.changed();
    return true;
  }

  exportProfile(): string {
    return this.configError || !this.registry.get(this.settings.profileId)
      ? JSON.stringify(this.rawSettings, null, 2)
      : this.registry.export(this.settings.profileId);
  }

  useProseFallback() {
    this.cancel();
    this.explicitProseFallback = true;
    this.notice = t("chat.dictation.developer.proseFallback");
    this.changed();
  }

  /** Snapshot target and settings before microphone permission or any provider await. */
  capture(): ComposerDictationReviewCapture | undefined {
    this.refreshSettings();
    if (
      this.configError
        ? this.explicitProseFallback
        : !this.settings.enabled || this.settings.mode === "prose"
    ) {
      return undefined;
    }
    this.retire();
    const target = this.options.captureTarget();
    const id = ++this.generation;
    const current: Review = {
      id,
      phase: "capturing",
      target: target ?? { isCurrent: () => false, insert: () => false },
      settings: this.settings,
      configuration: JSON.stringify(this.rawSettings),
      profile: this.configError ? undefined : this.registry.get(this.settings.profileId),
      raw: "",
      choices: {},
      omitted: new Set(),
      original: false,
      plan: null,
      text: null,
    };
    this.current = current;
    this.notice = "";
    this.changed();
    return {
      cancel: () => {
        if (this.current === current) {
          this.retire();
          this.changed();
        }
      },
      finish: (raw) => {
        if (this.current !== current || !this.isCurrent(current)) {
          this.sync();
          return;
        }
        current.raw = raw;
        current.phase = "review";
        this.prepare(current);
        this.changed();
      },
    };
  }

  private isCurrent(review: Review) {
    return (
      review.target.isCurrent() &&
      review.configuration === JSON.stringify(this.options.readSettings())
    );
  }

  sync(targetCurrent = this.targetCurrent) {
    if (this.current && !targetCurrent) {
      this.retire();
      this.options.cancelCapture();
      this.notice = t("chat.dictation.developer.stale");
      this.changed();
    }
  }

  private prepare(review: Review) {
    review.text = null;
    const profile = review.profile ?? builtinDeveloperProfiles[0]!;
    const request = {
      schemaVersion: 1 as const,
      captureId: `developer-${review.id}`,
      generation: review.id,
      transcriptRevision: 1,
      mode: "dictation" as const,
      rawTranscript: review.raw,
    };
    const plan = createDeveloperPlan({
      ...request,
      mode: review.original ? "prose" : review.profile ? review.settings.mode : "literal",
      locale: review.profile ? review.settings.locale : "unsupported",
      profile,
      choices: review.choices,
    });
    plan.edits = plan.edits.filter((edit) => !review.omitted.has(edit.intentId));
    review.plan = plan;
    if (
      !plan.supported ||
      plan.diagnostics.some((diagnostic) => diagnostic.severity === "blocking")
    ) {
      return;
    }
    try {
      review.text = applyDictationPlan(request, plan).text;
    } catch {
      this.notice = t("chat.dictation.developer.invalidPlan");
    }
  }

  choose(id: string, text: string) {
    const review = this.review;
    if (!review || !this.checkCurrent(review)) {
      return;
    }
    const diagnostic = review.plan?.diagnostics.find((candidate) => candidate.id === id);
    if (!diagnostic?.alternatives?.some((alternative) => alternative.text === text)) {
      return;
    }
    review.choices[id] = text;
    review.original = false;
    this.prepare(review);
    this.changed();
  }

  useOriginal() {
    const review = this.review;
    if (!review || !this.checkCurrent(review)) {
      return;
    }
    review.original = true;
    this.prepare(review);
    this.changed();
  }

  undoLast() {
    const review = this.review;
    const edit = review?.plan?.edits.at(-1);
    if (!review || !edit || !this.checkCurrent(review)) {
      return;
    }
    review.omitted.add(edit.intentId);
    this.prepare(review);
    this.changed();
  }

  accept(): boolean {
    const review = this.review;
    if (!review || review.text === null || !this.checkCurrent(review)) {
      return false;
    }
    if (review.target.canInsertExact?.(review.text) === false) {
      this.notice = t("chat.dictation.developer.copyRequired");
      this.changed();
      return false;
    }
    // Retire before the actual editor write so reentrant callbacks cannot publish twice.
    this.current = null;
    try {
      const inserted = review.target.insert(
        review.text,
        () =>
          this.generation === review.id &&
          review.configuration === JSON.stringify(this.options.readSettings()),
      );
      this.notice = t(
        inserted ? "chat.dictation.developer.inserted" : "chat.dictation.developer.stale",
      );
      this.changed();
      return inserted;
    } catch {
      // A host can throw after writing. Do not retry or restore a captured draft.
      this.notice = t("chat.dictation.developer.uncertainWrite");
      this.changed();
      return false;
    }
  }

  async copy(): Promise<boolean> {
    const review = this.review;
    if (!review || review.text === null || !this.checkCurrent(review)) {
      return false;
    }
    try {
      await this.options.copy(review.text);
      if (this.current === review) {
        this.notice = t("chat.dictation.developer.copied");
        this.changed();
      }
      return true;
    } catch {
      if (this.current === review) {
        this.notice = t("chat.dictation.developer.copyFailed");
        this.changed();
      }
      return false;
    }
  }

  private checkCurrent(review: Review) {
    if (this.isCurrent(review)) {
      return true;
    }
    this.sync();
    return false;
  }

  private retire() {
    this.current = null;
  }
  cancel() {
    if (!this.current) {
      return;
    }
    this.retire();
    this.options.cancelCapture();
    this.changed();
  }
  dispose() {
    this.retire();
  }
}
