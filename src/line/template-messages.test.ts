import { describe, expect, it } from "vitest";
import {
  createConfirmTemplate,
  createButtonTemplate,
  createTemplateCarousel,
  createCarouselColumn,
  createImageCarousel,
  createImageCarouselColumn,
  createYesNoConfirm,
  createProductCarousel,
  messageAction,
  uriAction,
  postbackAction,
  datetimePickerAction,
} from "./template-messages.js";

describe("messageAction", () => {
  it("creates a message action", () => {
    const action = messageAction("Click me", "clicked");

    expect(action.label).toBe("Click me");
    expect((action as { text: string }).text).toBe("clicked");
  });

  it("uses label as text when text not provided", () => {
    const action = messageAction("Click");

    expect((action as { text: string }).text).toBe("Click");
  });

  it("truncates label to 20 characters", () => {
    const action = messageAction("This is a very long label that exceeds the limit");

    expect(action.label).toBe("This is a very long ");
  });
});

describe("uriAction", () => {
  it("truncates labels and keeps target URL", () => {
    const action = uriAction("This label is definitely too long", "https://example.com");
    expect(action.label).toBe("This label is defini");
    expect((action as { uri: string }).uri).toBe("https://example.com");
  });
});

describe("postbackAction", () => {
  it("includes displayText when provided", () => {
    const action = postbackAction("Select", "data", "Selected!");

    expect(action.label).toBe("Select");
    expect((action as { data: string }).data).toBe("data");
    expect((action as { displayText: string }).displayText).toBe("Selected!");
  });

  it("truncates data to 300 characters", () => {
    const longData = "x".repeat(400);
    const action = postbackAction("Test", longData);

    expect((action as { data: string }).data.length).toBe(300);
  });
});

describe("datetimePickerAction", () => {
  it("includes min/max/initial when provided", () => {
    const action = datetimePickerAction("Pick", "data", "datetime", {
      initial: "2024-01-01T12:00",
      min: "2024-01-01T00:00",
      max: "2024-12-31T23:59",
    });

    expect(action.label).toBe("Pick");
    expect((action as { mode: string }).mode).toBe("datetime");
    expect((action as { initial: string }).initial).toBe("2024-01-01T12:00");
    expect((action as { min: string }).min).toBe("2024-01-01T00:00");
    expect((action as { max: string }).max).toBe("2024-12-31T23:59");
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

describe("createYesNoConfirm", () => {
  it("allows custom button text", () => {
    const template = createYesNoConfirm("Delete?", {
      yesText: "Delete",
      noText: "Cancel",
    });

    const actions = (template.template as { actions: Array<{ label: string }> }).actions;
    expect(actions[0].label).toBe("Delete");
    expect(actions[1].label).toBe("Cancel");
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
