import { describe, expect, it } from "vitest";
import {
  createConfirmTemplate,
  createButtonTemplate,
  createTemplateCarousel,
  createCarouselColumn,
  createImageCarousel,
  createImageCarouselColumn,
  createProductCarousel,
  messageAction,
  postbackAction,
} from "./template-messages.js";

describe("messageAction", () => {
  it("truncates label to 20 characters", () => {
    const action = messageAction("This is a very long label that exceeds the limit");

    expect(action.label).toBe("This is a very long ");
  });
});

describe("postbackAction", () => {
  it("truncates data to 300 characters", () => {
    const longData = "x".repeat(400);
    const action = postbackAction("Test", longData);

    expect((action as { data: string }).data.length).toBe(300);
  });
});

describe("createConfirmTemplate", () => {
  it("truncates text to 240 characters", () => {
    const longText = "x".repeat(300);
    const template = createConfirmTemplate(longText, messageAction("Yes"), messageAction("No"));

    expect((template.template as { text: string }).text.length).toBe(240);
  });
});

describe("createButtonTemplate", () => {
  it("limits actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => messageAction(`Button ${i}`));
    const template = createButtonTemplate("Title", "Text", actions);

    expect((template.template as { actions: unknown[] }).actions.length).toBe(4);
  });

  it("truncates title to 40 characters", () => {
    const longTitle = "x".repeat(50);
    const template = createButtonTemplate(longTitle, "Text", [messageAction("OK")]);

    expect((template.template as { title: string }).title.length).toBe(40);
  });

  it("truncates text to 60 chars when no thumbnail is provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")]);

    expect((template.template as { text: string }).text.length).toBe(60);
  });

  it("keeps longer text when thumbnail is provided", () => {
    const longText = "x".repeat(100);
    const template = createButtonTemplate("Title", longText, [messageAction("OK")], {
      thumbnailImageUrl: "https://example.com/thumb.jpg",
    });

    expect((template.template as { text: string }).text.length).toBe(100);
  });
});

describe("createTemplateCarousel", () => {
  it("limits columns to 10", () => {
    const columns = Array.from({ length: 15 }, () =>
      createCarouselColumn({ text: "Text", actions: [messageAction("OK")] }),
    );
    const template = createTemplateCarousel(columns);

    expect((template.template as { columns: unknown[] }).columns.length).toBe(10);
  });
});

describe("createCarouselColumn", () => {
  it("limits actions to 3", () => {
    const column = createCarouselColumn({
      text: "Text",
      actions: [
        messageAction("A1"),
        messageAction("A2"),
        messageAction("A3"),
        messageAction("A4"),
        messageAction("A5"),
      ],
    });

    expect(column.actions.length).toBe(3);
  });

  it("truncates text to 120 characters", () => {
    const longText = "x".repeat(150);
    const column = createCarouselColumn({ text: longText, actions: [messageAction("OK")] });

    expect(column.text.length).toBe(120);
  });
});

describe("createImageCarousel", () => {
  it("limits columns to 10", () => {
    const columns = Array.from({ length: 15 }, (_, i) =>
      createImageCarouselColumn(`https://example.com/${i}.jpg`, messageAction("View")),
    );
    const template = createImageCarousel(columns);

    expect((template.template as { columns: unknown[] }).columns.length).toBe(10);
  });
});

describe("createProductCarousel", () => {
  it("uses URI action when actionUrl provided", () => {
    const template = createProductCarousel([
      {
        title: "Product",
        description: "Desc",
        actionLabel: "Buy",
        actionUrl: "https://shop.com/buy",
      },
    ]);

    const columns = (template.template as { columns: Array<{ actions: Array<{ type: string }> }> })
      .columns;
    expect(columns[0].actions[0].type).toBe("uri");
  });

  it("uses postback action when actionData provided", () => {
    const template = createProductCarousel([
      {
        title: "Product",
        description: "Desc",
        actionLabel: "Select",
        actionData: "product_id=123",
      },
    ]);

    const columns = (template.template as { columns: Array<{ actions: Array<{ type: string }> }> })
      .columns;
    expect(columns[0].actions[0].type).toBe("postback");
  });
});
