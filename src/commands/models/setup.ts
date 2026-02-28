import { isCancel, text } from "@clack/prompts";
import { ModelConfigPropagator } from "../../config/model-config-propagator.js";
import {
  generateSimpleModelConfig,
  getConfigProfileDescriptions,
} from "../../config/simple-config.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { RuntimeEnv } from "../../runtime.js";
import { selectStyled } from "../../terminal/prompt-select-styled.js";
import { stylePromptMessage } from "../../terminal/prompt-style.js";
import { theme } from "../../terminal/theme.js";
import { updateConfig } from "./shared.js";

function cancelled(runtime: RuntimeEnv) {
  runtime.log(theme.muted("Setup cancelled."));
  runtime.exit(0);
}

export async function modelsSetupCommand(runtime: RuntimeEnv): Promise<void> {
  if (!process.stdin.isTTY) {
    runtime.error("models setup requires a TTY. Run it in an interactive terminal.");
    runtime.exit(1);
    return;
  }

  const profileDescriptions = getConfigProfileDescriptions();

  // Step 1: pick a profile
  const profile = await selectStyled({
    message: "Model configuration profile",
    options: profileDescriptions.map((p) => ({
      value: p.profile,
      label:
        p.profile === "simple"
          ? "Simple"
          : p.profile === "resilient"
            ? "Resilient (recommended)"
            : "Commercial",
      hint: p.description,
    })),
    initialValue: "resilient" as const,
  });

  if (isCancel(profile)) {
    cancelled(runtime);
    return;
  }

  let modelConfig: AgentModelConfig;

  if (profile === "simple") {
    // Step 2a: single model
    const primary = await text({
      message: stylePromptMessage("Primary model (e.g. anthropic/claude-sonnet-4-6)"),
      placeholder: "anthropic/claude-sonnet-4-6",
      validate: (v) => ((v ?? "").trim() ? undefined : "Model name is required."),
    });
    if (isCancel(primary)) {
      cancelled(runtime);
      return;
    }
    const generated = generateSimpleModelConfig("simple", primary.trim());
    modelConfig = generated.model;
  } else if (profile === "resilient") {
    // Step 2b: primary + fallbacks
    const primary = await text({
      message: stylePromptMessage("Primary model (e.g. anthropic/claude-sonnet-4-6)"),
      placeholder: "anthropic/claude-sonnet-4-6",
      validate: (v) => ((v ?? "").trim() ? undefined : "Model name is required."),
    });
    if (isCancel(primary)) {
      cancelled(runtime);
      return;
    }

    const fallbacksRaw = await text({
      message: stylePromptMessage(
        "Fallback models, comma-separated (leave blank to skip, e.g. openai/gpt-4o,groq/llama3-70b)",
      ),
      placeholder: "openai/gpt-4o",
    });
    if (isCancel(fallbacksRaw)) {
      cancelled(runtime);
      return;
    }

    const fallbacks = (fallbacksRaw ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);

    const generated = generateSimpleModelConfig("resilient", primary.trim(), fallbacks);
    modelConfig = generated.model;
  } else {
    // Step 2c: commercial — reasoning / coding / budget
    const reasoning = await text({
      message: stylePromptMessage("Reasoning model (e.g. anthropic/claude-opus-4-6)"),
      placeholder: "anthropic/claude-opus-4-6",
      validate: (v) => ((v ?? "").trim() ? undefined : "Model name is required."),
    });
    if (isCancel(reasoning)) {
      cancelled(runtime);
      return;
    }

    const coding = await text({
      message: stylePromptMessage("Coding model (e.g. anthropic/claude-sonnet-4-6)"),
      placeholder: "anthropic/claude-sonnet-4-6",
      validate: (v) => ((v ?? "").trim() ? undefined : "Model name is required."),
    });
    if (isCancel(coding)) {
      cancelled(runtime);
      return;
    }

    const budget = await text({
      message: stylePromptMessage("Budget model (e.g. openai/gpt-4o-mini)"),
      placeholder: "openai/gpt-4o-mini",
      validate: (v) => ((v ?? "").trim() ? undefined : "Model name is required."),
    });
    if (isCancel(budget)) {
      cancelled(runtime);
      return;
    }

    const generated = generateSimpleModelConfig("commercial", {
      reasoningModel: reasoning.trim(),
      codingModel: coding.trim(),
      budgetModel: budget.trim(),
    });
    modelConfig = generated.model;
  }

  // Write config
  await updateConfig((cfg) => {
    cfg.agents = cfg.agents ?? {};
    cfg.agents.defaults = cfg.agents.defaults ?? {};
    cfg.agents.defaults.model = modelConfig;
    return cfg;
  });

  // Propagate to all session stores (Bug #3)
  const primaryModel =
    typeof modelConfig === "string"
      ? modelConfig
      : ((modelConfig as { primary?: string }).primary ?? "");

  if (primaryModel) {
    const propagator = new ModelConfigPropagator();
    await propagator.setModel(primaryModel, "global").catch(() => undefined);
  }

  const summary =
    typeof modelConfig === "string" ? modelConfig : JSON.stringify(modelConfig, null, 2);

  runtime.log(`\n${theme.success("Model configuration saved:")}\n${summary}`);
}
