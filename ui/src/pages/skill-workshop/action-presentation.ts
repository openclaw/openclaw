import {
  action,
  affects,
  createMemo,
  createOptimistic,
  refresh,
  type SourceAccessor,
} from "solid-js";
import type { SkillWorkshopMode } from "./mode.ts";
import type { SkillWorkshopPageState } from "./skill-workshop-page.tsx";

/** Scoped pending feedback for actions whose result is not a predictable library move. */
export function createWorkshopActionPresentation(
  owner: Pick<SkillWorkshopPageState, "scope" | "presentationFailed">,
  scope: () => SkillWorkshopPageState["scope"],
  list: SourceAccessor<unknown>,
  mode: SourceAccessor<SkillWorkshopMode | null>,
) {
  const presentation = createMemo(() => {
    const currentScope = scope();
    const [pendingAction, setPendingAction] = createOptimistic<string | null>(null);
    const [modeBusy, setModeBusy] = createOptimistic(false);
    const [learningBusy, setLearningBusy] = createOptimistic(false);
    const [expectedMode, setExpectedMode] = createOptimistic(() => mode());
    return {
      currentScope,
      pendingAction,
      setPendingAction,
      modeBusy,
      setModeBusy,
      learningBusy,
      setLearningBusy,
      expectedMode,
      setExpectedMode,
    };
  });
  const present = action(function* (
    captured: ReturnType<typeof presentation>,
    result: Promise<void>,
    kind: "mutation" | "mode" | "learning",
    expected?: string,
  ) {
    if (owner.scope === captured.currentScope) {
      if (kind === "mutation") {
        captured.setPendingAction(expected ?? null);
        affects(list);
      } else if (kind === "mode") {
        captured.setModeBusy(true);
        captured.setExpectedMode(expected === "auto" || expected === "propose" ? expected : "off");
      } else {
        captured.setLearningBusy(true);
      }
    }
    yield Promise.race([result, captured.currentScope?.retired ?? Promise.resolve()]);
    if (owner.scope === captured.currentScope) {
      if (kind === "mutation") {
        // The owner already reloaded; this only reconciles its read receipt.
        yield refresh(list).catch(() => undefined);
      } else if (kind === "mode") {
        yield refresh(mode);
      }
    }
  });
  const run = async (
    kind: "mutation" | "mode" | "learning",
    operation: () => Promise<void>,
    expected?: string,
  ) => {
    const captured = presentation();
    const result = operation();
    // Land synchronous owner admission before joining the presentation transition.
    await Promise.resolve();
    try {
      await present(captured, result, kind, expected);
    } catch (error) {
      if (owner.scope === captured.currentScope) {
        owner.presentationFailed(kind, error);
      }
    }
  };
  return { presentation, run };
}
