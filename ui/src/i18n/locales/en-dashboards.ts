import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enDashboards = {
  dashboardsPage: {
    emptyTitle: "No dashboards yet",
    emptyDescription: "Dashboards created in your sessions appear here.",
    loadError: "Couldn’t load dashboards. Try again. {error}",
    openFocusMode: "Open dashboard in focus mode",
    running: "Updating now",
    you: "You",
    byAuthor: "Session: {author}",
    updatedLabel: "Updated",
    updatedUnknown: "Update time unknown",
    searchLabel: "Search dashboards",
    searchPlaceholder: "Search dashboards…",
    closeSearch: "Close search",
    filterByAuthor: "Filter by session attribution",
    filterAuthors: "Search session attributions…",
    clearAuthors: "Clear",
    noAuthorsMatch: "No session attributions match “{query}”",
    authorIs: "Session attribution is",
    authorCount: "{count} session attributions",
    removeAuthorFilter: "Remove session attribution filter",
    display: "Display",
    viewGrid: "Grid",
    viewList: "List",
    ordering: "Ordering",
    grouping: "Grouping",
    groupNone: "No grouping",
    groupUpdated: "Last updated",
    groupAuthor: "Session attribution",
    groupToday: "Today",
    groupThisWeek: "This week",
    groupEarlier: "Earlier",
    sortUpdated: "Recently updated",
    sortTitle: "Title A–Z",
    noResultsTitle: "No dashboards match your search.",
    noResultsDescription: "Try another search or session attribution.",
  },
} satisfies TranslationMap;

export const registerDashboardsEnglish = Object.assign(
  () => {
    Object.assign(en.dashboardsPage, enDashboards.dashboardsPage);
  },
  { catalog: enDashboards },
);
