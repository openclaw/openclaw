import { describe, expect, it } from "vitest";
import {
  createInfoCard,
  createListCard,
  createImageCard,
  createActionCard,
  createCarousel,
  createNotificationBubble,
  createEventCard,
  createDeviceControlCard,
} from "./flex-templates.js";

describe("createInfoCard", () => {
  it("includes footer when provided", () => {
    const card = createInfoCard("Title", "Body", "Footer text");

    const footer = card.footer as { contents: Array<{ text: string }> };
    expect(footer.contents[0].text).toBe("Footer text");
  });
});

describe("createListCard", () => {
  it("limits items to 8", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}` }));
    const card = createListCard("List", items);

    const body = card.body as { contents: Array<{ type: string; contents?: unknown[] }> };
    // The list items are in the third content (after title and separator)
    const listBox = body.contents[2] as { contents: unknown[] };
    expect(listBox.contents.length).toBe(8);
  });

  it("includes actions on items when provided", () => {
    const items = [
      {
        title: "Clickable",
        action: { type: "message" as const, label: "Click", text: "clicked" },
      },
    ];
    const card = createListCard("List", items);
    const body = card.body as {
      contents: Array<{ type: string; contents?: Array<{ action?: unknown }> }>;
    };
    const listBox = body.contents[2] as { contents: Array<{ action?: unknown }> };
    expect(listBox.contents[0].action).toEqual(items[0].action);
  });
});

describe("createImageCard", () => {
  it("includes body text when provided", () => {
    const card = createImageCard("https://example.com/img.jpg", "Title", "Body text");

    const body = card.body as { contents: Array<{ text: string }> };
    expect(body.contents.length).toBe(2);
    expect(body.contents[1].text).toBe("Body text");
  });
});

describe("createActionCard", () => {
  it("limits actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({
      label: `Action ${i}`,
      action: { type: "message" as const, label: `A${i}`, text: `action${i}` },
    }));
    const card = createActionCard("Title", "Body", actions);

    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBe(4);
  });
});

describe("createCarousel", () => {
  it("limits to 12 bubbles", () => {
    const bubbles = Array.from({ length: 15 }, (_, i) => createInfoCard(`Card ${i}`, `Body ${i}`));
    const carousel = createCarousel(bubbles);

    expect(carousel.contents.length).toBe(12);
  });
});

describe("createNotificationBubble", () => {
  it("includes title when provided", () => {
    const bubble = createNotificationBubble("Details here", {
      title: "Alert Title",
    });
    const body = bubble.body as { contents: Array<{ contents?: Array<{ text?: string }> }> };
    const contentSection = body.contents[1] as { contents: Array<{ text?: string }> };
    expect(contentSection.contents[0].text).toBe("Alert Title");
  });
});

describe("createDeviceControlCard", () => {
  it("limits controls to 6", () => {
    const card = createDeviceControlCard({
      deviceName: "Device",
      controls: Array.from({ length: 10 }, (_, i) => ({
        label: `Control ${i}`,
        data: `action=${i}`,
      })),
    });

    // Should have max 3 rows of 2 buttons
    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBeLessThanOrEqual(3);
  });
});

describe("createEventCard", () => {
  it("includes all optional fields together", () => {
    const card = createEventCard({
      title: "Team Offsite",
      date: "February 15, 2026",
      time: "9:00 AM - 5:00 PM",
      location: "Mountain View Office",
      description: "Annual team building event",
    });

    expect(card.size).toBe("mega");
    const body = card.body as { contents: Array<{ type: string }> };
    expect(body.contents).toHaveLength(3);
  });
});
