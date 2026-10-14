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

export function sourcePreviewHistory(sessionUrl?: string) {
  const fixture = sourcePreviewFixture;
  const start = Date.UTC(2026, 8, 14, 12, 0);
  const metadata = (seq: number) => ({
    __openclaw: { id: `source-preview-${seq}`, seq, runId: fixture.runId },
    timestamp: start + seq * 5_000,
  });
  const search = {
    kind: "results",
    provider: "fixture",
    query: "weekend cycling checklist and weather",
    count: sessionUrl ? 5 : 3,
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
      ...(sessionUrl
        ? [
            { title: wrapWebContent("Trip planning session", "web_search"), url: sessionUrl },
            {
              title: wrapWebContent("Route planner issue", "web_search"),
              url: "https://github.com/example/route-planner/issues/42",
            },
          ]
        : []),
    ],
    externalContent: { untrusted: true, source: "web_search", wrapped: true, provider: "fixture" },
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
    extractMode: "markdown",
    extractor: "fixture",
    truncated: false,
    externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
  };
  return [
    {
      ...metadata(1),
      role: "user",
      content: [{ type: "text", text: "Help me pack for a weekend bike trip." }],
    },
    {
      ...metadata(2),
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "source-search",
          name: "web_search",
          arguments: { query: search.query },
        },
      ],
    },
    {
      ...metadata(3),
      role: "toolResult",
      toolCallId: "source-search",
      toolName: "web_search",
      details: search,
      content: [{ type: "text", text: JSON.stringify(search) }],
    },
    {
      ...metadata(4),
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "source-fetch",
          name: "web_fetch",
          arguments: { url: fixture.checklistUrl },
        },
      ],
    },
    {
      ...metadata(5),
      role: "toolResult",
      toolCallId: "source-fetch",
      toolName: "web_fetch",
      details: page,
      content: [{ type: "text", text: JSON.stringify(page) }],
    },
    {
      ...metadata(6),
      role: "assistant",
      phase: "final_answer",
      stopReason: "stop",
      content: [
        {
          type: "text",
          text:
            fixture.answer +
            (sessionUrl
              ? `\n\nRelated: [trip planning session](${sessionUrl}) · [route planner issue](https://github.com/example/route-planner/issues/42).`
              : ""),
        },
      ],
    },
  ];
}
