import type { ApplicationContext } from "../../app/context.ts";

export function navigateToSpeechSettings(context: Pick<ApplicationContext, "navigate">) {
  context.navigate("communications", {
    search: "?section=tts&advanced=1",
    hash: "#config-section-tts",
  });
}
