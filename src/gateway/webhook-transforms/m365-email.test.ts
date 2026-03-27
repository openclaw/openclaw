import { describe, expect, test } from "vitest";
import { transformM365EmailPayload } from "./m365-email.js";

const RESOURCE =
  "users/larry@example.com/messages/AAMkAGNmOTI5LTg5ZjktNGJjYi1iMzQzLWU3ZWYwYjhmZDQ0MgBGAAAAAAB-xyz";

describe("transformM365EmailPayload", () => {
  test("transforms new email notification", () => {
    const payload = {
      value: [
        {
          subscriptionId: "sub-123",
          clientState: "larry-mailbox-monitor",
          changeType: "created",
          resource: RESOURCE,
          resourceData: {
            "@odata.type": "#Microsoft.Graph.Message",
            "@odata.id": RESOURCE,
          },
        },
      ],
    };

    const result = transformM365EmailPayload(payload);

    expect(result).not.toBeNull();
    expect(result?.message).toContain("M365: New Email Received");
    expect(result?.message).toContain("larry@example.com");
    expect(result?.message).toContain(
      "AAMkAGNmOTI5LTg5ZjktNGJjYi1iMzQzLWU3ZWYwYjhmZDQ0MgBGAAAAAAB-xyz",
    );
    expect(result?.message).toContain("larry-mailbox-monitor");
    expect(result?.name).toBe("M365 Email: larry@example.com");
    expect(result?.sessionKey).toBe(
      "webhook:m365-email:AAMkAGNmOTI5LTg5ZjktNGJjYi1iMzQzLWU3ZWYwYjhmZDQ0MgBGAAAAAAB-xyz",
    );
  });

  test("returns null for empty notifications array", () => {
    const result = transformM365EmailPayload({ value: [] });
    expect(result).toBeNull();
  });

  test("returns null when value field is missing", () => {
    const result = transformM365EmailPayload({});
    expect(result).toBeNull();
  });

  test("returns null when message ID cannot be extracted from resource", () => {
    const result = transformM365EmailPayload({
      value: [
        {
          changeType: "created",
          resource: "users/larry@example.com/mailFolders/inbox",
        },
      ],
    });
    expect(result).toBeNull();
  });

  test("omits client state line when clientState is absent", () => {
    const payload = {
      value: [
        {
          changeType: "created",
          resource: RESOURCE,
        },
      ],
    };

    const result = transformM365EmailPayload(payload);

    expect(result).not.toBeNull();
    expect(result?.message).not.toContain("Client State");
  });

  test("extracts mailbox as unknown when user path is missing", () => {
    const payload = {
      value: [
        {
          changeType: "created",
          resource: "messages/AAMkSomeMessageId",
        },
      ],
    };

    const result = transformM365EmailPayload(payload);

    expect(result).not.toBeNull();
    expect(result?.name).toBe("M365 Email: unknown");
  });

  test("uses changeType in message body", () => {
    const payload = {
      value: [
        {
          changeType: "updated",
          resource: RESOURCE,
        },
      ],
    };

    const result = transformM365EmailPayload(payload);

    expect(result?.message).toContain("updated");
  });
});
