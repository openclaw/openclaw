/** Synthetic corpus shared by the built-renderer test and its visual proof. */
export const a2uiV09CatalogId = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

export function a2uiV09Corpus() {
  const text = (id: string, value: string) => ({ id, component: "Text", text: value });
  return [
    {
      version: "v0.9",
      createSurface: {
        surfaceId: "main",
        catalogId: a2uiV09CatalogId,
        theme: { primaryColor: "#197a55" },
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "main",
        path: "/",
        value: {
          name: "Ada",
          enabled: true,
          amount: 35,
          when: "2026-10-20T14:30:00",
          choices: ["a"],
          items: [{ title: "First item" }, { title: "Second item" }],
        },
      },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "main",
        components: [
          { id: "root", component: "Column", children: ["title", "intro", "divider", "columns"] },
          { id: "title", component: "Text", text: "Canvas catalog", variant: "h2" },
          text("intro", "A **live** form with _bound_ values and safe `Markdown`."),
          { id: "divider", component: "Divider" },
          {
            id: "columns",
            component: "Row",
            children: ["form-card", "media-card"],
            align: "start",
          },
          { id: "form-card", component: "Card", child: "form", weight: 1 },
          {
            id: "form",
            component: "Column",
            children: ["name", "echo", "enabled", "amount", "when", "choices", "submit"],
          },
          { id: "name", component: "TextField", label: "Name", value: { path: "/name" } },
          { id: "echo", component: "Text", text: { path: "/name" } },
          {
            id: "enabled",
            component: "CheckBox",
            label: "Notifications",
            value: { path: "/enabled" },
          },
          {
            id: "amount",
            component: "Slider",
            label: "Capacity",
            min: 0,
            max: 100,
            value: { path: "/amount" },
          },
          {
            id: "when",
            component: "DateTimeInput",
            enableDate: true,
            enableTime: true,
            value: { path: "/when" },
          },
          {
            id: "choices",
            component: "ChoicePicker",
            label: "Projects",
            variant: "multipleSelection",
            displayStyle: "chips",
            filterable: true,
            value: { path: "/choices" },
            options: [
              { label: "Alpha", value: "a" },
              { label: "Beta", value: "b" },
            ],
          },
          {
            id: "submit",
            component: "Button",
            child: "submit-label",
            variant: "primary",
            action: {
              event: {
                name: "save",
                context: {
                  name: { path: "/name" },
                  enabled: { path: "/enabled" },
                  amount: { path: "/amount" },
                  when: { path: "/when" },
                  choices: { path: "/choices" },
                },
              },
            },
          },
          text("submit-label", "Save changes"),
          { id: "media-card", component: "Card", child: "media", weight: 1 },
          {
            id: "media",
            component: "Column",
            children: ["icon", "image", "tabs", "modal", "video", "audio"],
          },
          { id: "icon", component: "Icon", name: { svgPath: "M3 12l6 6L21 6l-2-2L9 14l-4-4z" } },
          {
            id: "image",
            component: "Image",
            url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='360' height='80'%3E%3Crect width='360' height='80' fill='%23d5eee3'/%3E%3Ctext x='24' y='47' fill='%2319674b' font-family='sans-serif' font-size='20'%3ESynthetic image%3C/text%3E%3C/svg%3E",
            description: "Synthetic landscape",
            fit: "contain",
            variant: "smallFeature",
          },
          {
            id: "tabs",
            component: "Tabs",
            tabs: [
              { title: "Items", child: "items" },
              { title: "Notes", child: "notes" },
            ],
          },
          { id: "items", component: "List", children: { componentId: "item", path: "/items" } },
          { id: "item", component: "Text", text: { path: "title" } },
          text("notes", "Second tab content"),
          { id: "modal", component: "Modal", trigger: "modal-trigger", content: "modal-content" },
          {
            id: "modal-trigger",
            component: "Button",
            child: "modal-label",
            action: { event: { name: "open" } },
          },
          text("modal-label", "Open details"),
          text("modal-content", "Details in a dialog"),
          { id: "video", component: "Video", url: "" },
          { id: "audio", component: "AudioPlayer", url: "", description: "Sample audio" },
        ],
      },
    },
  ];
}
