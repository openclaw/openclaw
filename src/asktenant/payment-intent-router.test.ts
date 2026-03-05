import { describe, expect, it } from "vitest";
import { routeTopPaymentIntent } from "./payment-intent-router.js";

describe("AskTenant top payment intent router", () => {
  it("routes current balance requests as api-first", () => {
    const result = routeTopPaymentIntent("What is my current balance?");

    expect(result).toEqual({
      intent: "account.current_balance",
      executionMode: "api-first",
      confidence: "high",
      reason: "Current balance is a direct account lookup from the PM system of record.",
      requiredApiFields: ["resident_id", "unit_id", "current_balance", "as_of_timestamp"],
    });
  });

  it("routes next payment due requests as api-first", () => {
    const result = routeTopPaymentIntent("When is my next HOA payment due?");

    expect(result?.intent).toBe("account.next_payment_due");
    expect(result?.executionMode).toBe("api-first");
  });

  it("routes last payment receipt requests as api-first", () => {
    const result = routeTopPaymentIntent("Did you receive my last payment?");

    expect(result?.intent).toBe("account.last_payment_received");
    expect(result?.executionMode).toBe("api-first");
  });

  it("routes amount owed requests as api-first", () => {
    const result = routeTopPaymentIntent("How much do I owe right now?");

    expect(result?.intent).toBe("account.amount_owed");
    expect(result?.executionMode).toBe("api-first");
  });

  it("routes delinquency requests as api-first", () => {
    const result = routeTopPaymentIntent("Am I delinquent?");

    expect(result?.intent).toBe("account.delinquency_status");
    expect(result?.executionMode).toBe("api-first");
  });

  it("returns null for non-payment intents", () => {
    const result = routeTopPaymentIntent("Can I reserve the clubhouse this Saturday?");

    expect(result).toBeNull();
  });
});
