import { describe, expect, test } from "vitest";
import { AccessController } from "../access-control/access-controller.js";
import { AccountError, AccountManager } from "./account-manager.js";

function adminActor(): AccessController {
  return new AccessController("admin");
}

function observerActor(): AccessController {
  return new AccessController("observer");
}

describe("AccountManager.create", () => {
  test("creates an account with valid inputs", async () => {
    const mgr = new AccountManager();
    const account = await mgr.create(
      {
        username: "alice",
        role: "operator",
        password: "Correct!Horse#Battery9",
        createdBy: "admin-bootstrap",
      },
      adminActor(),
    );

    expect(account.username).toBe("alice");
    expect(account.role).toBe("operator");
    expect(account.status).toBe("active");
    expect(account.requireMfa).toBe(true);
    expect(account.passwordHash).not.toBe("Correct!Horse#Battery9");
  });

  test("rejects weak password", async () => {
    const mgr = new AccountManager();
    await expect(
      mgr.create(
        { username: "bob", role: "guest", password: "weak", createdBy: "admin" },
        adminActor(),
      ),
    ).rejects.toThrow(AccountError);
  });

  test("rejects duplicate username", async () => {
    const mgr = new AccountManager();
    const input = {
      username: "alice",
      role: "observer" as const,
      password: "Correct!Horse#Battery9",
      createdBy: "admin",
    };
    await mgr.create(input, adminActor());
    await expect(mgr.create(input, adminActor())).rejects.toThrow(AccountError);
  });

  test("denies creation for non-admin actor", async () => {
    const mgr = new AccountManager();
    await expect(
      mgr.create(
        { username: "carol", role: "guest", password: "Correct!Horse#Battery9", createdBy: "x" },
        observerActor(),
      ),
    ).rejects.toThrow("Access denied");
  });
});

describe("AccountManager.disable / enable", () => {
  test("disables an active account", async () => {
    const mgr = new AccountManager();
    const account = await mgr.create(
      { username: "dan", role: "observer", password: "Correct!Horse#Battery9", createdBy: "admin" },
      adminActor(),
    );

    const disabled = await mgr.disable(account.id, adminActor());
    expect(disabled.status).toBe("disabled");
    expect(disabled.disabledAt).toBeTruthy();
  });

  test("re-enables a disabled account", async () => {
    const mgr = new AccountManager();
    const account = await mgr.create(
      { username: "eve", role: "observer", password: "Correct!Horse#Battery9", createdBy: "admin" },
      adminActor(),
    );
    await mgr.disable(account.id, adminActor());
    const enabled = await mgr.enable(account.id, adminActor());
    expect(enabled.status).toBe("active");
    expect(enabled.disabledAt).toBeNull();
  });

  test("throws when disabling already-disabled account", async () => {
    const mgr = new AccountManager();
    const account = await mgr.create(
      {
        username: "frank",
        role: "observer",
        password: "Correct!Horse#Battery9",
        createdBy: "admin",
      },
      adminActor(),
    );
    await mgr.disable(account.id, adminActor());
    await expect(mgr.disable(account.id, adminActor())).rejects.toThrow(AccountError);
  });
});

describe("AccountManager.list", () => {
  test("lists all accounts for admin", async () => {
    const mgr = new AccountManager();
    await mgr.create(
      { username: "g1", role: "guest", password: "Correct!Horse#Battery9", createdBy: "admin" },
      adminActor(),
    );
    await mgr.create(
      { username: "o1", role: "operator", password: "Correct!Horse#Battery9", createdBy: "admin" },
      adminActor(),
    );
    const all = mgr.list(adminActor());
    expect(all.length).toBe(2);
  });

  test("filters by role", async () => {
    const mgr = new AccountManager();
    await mgr.create(
      { username: "h1", role: "guest", password: "Correct!Horse#Battery9", createdBy: "admin" },
      adminActor(),
    );
    await mgr.create(
      { username: "h2", role: "admin", password: "Correct!Horse#Battery9", createdBy: "admin" },
      adminActor(),
    );
    const guests = mgr.list(adminActor(), { role: "guest" });
    expect(guests.every((a) => a.role === "guest")).toBe(true);
  });

  test("denies listing for guest actor", async () => {
    const mgr = new AccountManager();
    expect(() => mgr.list(new AccessController("guest"))).toThrow("Access denied");
  });
});

describe("AccountManager.changePassword", () => {
  test("updates password successfully", async () => {
    const mgr = new AccountManager();
    const account = await mgr.create(
      {
        username: "iris",
        role: "operator",
        password: "Correct!Horse#Battery9",
        createdBy: "admin",
      },
      adminActor(),
    );
    await expect(
      mgr.changePassword(account.id, "Correct!Horse#Battery9", "NewP@ssw0rd#12"),
    ).resolves.toBeUndefined();
  });

  test("rejects wrong current password", async () => {
    const mgr = new AccountManager();
    const account = await mgr.create(
      { username: "jay", role: "guest", password: "Correct!Horse#Battery9", createdBy: "admin" },
      adminActor(),
    );
    await expect(
      mgr.changePassword(account.id, "WrongPassword!", "NewP@ssw0rd#12"),
    ).rejects.toThrow(AccountError);
  });

  test("prevents password reuse", async () => {
    const mgr = new AccountManager();
    const account = await mgr.create(
      { username: "kim", role: "guest", password: "Correct!Horse#Battery9", createdBy: "admin" },
      adminActor(),
    );
    await mgr.changePassword(account.id, "Correct!Horse#Battery9", "NewP@ssw0rd#12");
    // Try to reuse the original password
    await expect(
      mgr.changePassword(account.id, "NewP@ssw0rd#12", "Correct!Horse#Battery9"),
    ).rejects.toThrow(AccountError);
  });
});
