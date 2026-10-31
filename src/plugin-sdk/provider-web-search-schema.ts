/** Shared fields for search providers whose tool accepts up to ten results. */
export const WEB_SEARCH_QUERY_COUNT_PROPERTIES = {
  query: { type: "string", description: "Search query string." },
  count: {
    type: "integer",
    description: "Number of results to return (1-10).",
    minimum: 1,
    maximum: 10,
  },
} as const;
