import { wrapWebContent } from "../../../src/security/external-content.js";

export const sourcePreviewFixture = {
  sessionKey: "agent:main:dashboard:source-previews",
  runId: "source-preview-research",
  checklistUrl: "https://cycling.example.com/weekend-checklist",
  forecastUrl: "https://weather.example.org/weekend",
  checklistTitle: "Weekend packing checklist",
  forecastTitle: "Weekend cycling forecast",
  answer:
    "Pack a repair kit, lights, and a waterproof layer from the [weekend checklist](https://cycling.example.com/weekend-checklist). " +
    "Check the [wind and rain forecast](https://weather.example.org/weekend) before leaving.",
};

export function sourcePreviewHistory(sessionUrl: string) {
  const fixture = sourcePreviewFixture;
  const start = Date.UTC(2026, 8, 14, 12, 0);
  const message = (seq: number, role: string, text: string, extra = {}) => ({
    __openclaw: { id: `source-preview-${seq}`, seq, runId: fixture.runId },
    timestamp: start + seq * 5_000,
    role,
    content: [{ type: "text", text }],
    ...extra,
  });
  const toolExchange = (seq: number, id: string, name: string, args: object, details: object) => [
    message(seq, "assistant", "", {
      content: [{ type: "toolCall", id, name, arguments: args }],
    }),
    message(seq + 1, "toolResult", JSON.stringify(details), {
      toolCallId: id,
      toolName: name,
      details,
    }),
  ];
  const search = {
    kind: "results",
    query: "weekend cycling checklist and weather",
    results: [
      { title: wrapWebContent(fixture.checklistTitle, "web_search"), url: fixture.checklistUrl },
      {
        title: wrapWebContent(fixture.forecastTitle, "web_search"),
        url: fixture.forecastUrl,
        snippet: wrapWebContent(
          "A light headwind on Saturday, with rain arriving on Sunday afternoon.",
          "web_search",
        ),
      },
      {
        title: wrapWebContent("City bike rentals", "web_search"),
        url: "https://rentals.example.com/",
      },
      { title: wrapWebContent("Trip planning session", "web_search"), url: sessionUrl },
      {
        title: wrapWebContent("Route planner issue", "web_search"),
        url: "https://github.com/example/route-planner/issues/42",
      },
    ],
    externalContent: { untrusted: true, source: "web_search", wrapped: true },
  };
  const page = {
    url: fixture.checklistUrl,
    finalUrl: fixture.checklistUrl,
    title: wrapWebContent(fixture.checklistTitle, "web_fetch"),
    text: wrapWebContent(
      "Bring a spare tube, tire levers, a pump, front and rear lights, and a waterproof layer. Carry enough water for the route.",
      "web_fetch",
    ),
    status: 200,
    externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
  };
  return [
    message(1, "user", "Help me pack for a weekend bike trip."),
    ...toolExchange(2, "source-search", "web_search", { query: search.query }, search),
    ...toolExchange(4, "source-fetch", "web_fetch", { url: fixture.checklistUrl }, page),
    message(
      6,
      "assistant",
      fixture.answer +
        `\n\nRelated: [trip planning session](${sessionUrl}) · [route planner issue](https://github.com/example/route-planner/issues/42).`,
      { phase: "final_answer", stopReason: "stop" },
    ),
  ];
}
