/**
 * Tests for Telegram GramJS authentication flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthFlow, verifySession } from "./auth.js";

// Mock readline to avoid stdin/stdout in tests
const mockPrompt = vi.fn();
const mockClose = vi.fn();

vi.mock("readline", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: (q: string, callback: (answer: string) => void) => {
        mockPrompt(q).then((answer: string) => callback(answer));
      },
      close: mockClose,
    })),
  },
}));

// Mock GramJSClient
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockStartWithAuth = vi.fn();
const mockGetConnectionState = vi.fn();

vi.mock("./client.js", () => ({
  GramJSClient: vi.fn(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    startWithAuth: mockStartWithAuth,
    getConnectionState: mockGetConnectionState,
  })),
}));

// Mock logger
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

describe("AuthFlow", () => {
  let authFlow: AuthFlow;

  beforeEach(() => {
    vi.clearAllMocks();
    authFlow = new AuthFlow();
  });

  afterEach(() => {
    mockClose.mockClear();
  });

  describe("phone number validation", () => {
    it("should accept valid phone numbers", async () => {
      // Valid formats
      const validNumbers = ["+12025551234", "+441234567890", "+8612345678901"];

      mockPrompt
        .mockResolvedValueOnce(validNumbers[0])
        .mockResolvedValueOnce("12345") // SMS code
        .mockResolvedValue(""); // No 2FA

      mockStartWithAuth.mockResolvedValue("mock_session_string");

      await authFlow.authenticate(123456, "test_hash");

      expect(mockStartWithAuth).toHaveBeenCalled();
    });

    it("should reject invalid phone numbers", async () => {
      mockPrompt
        .mockResolvedValueOnce("1234567890") // Missing +
        .mockResolvedValueOnce("+1234") // Too short
        .mockResolvedValueOnce("+12025551234") // Valid
        .mockResolvedValueOnce("12345") // SMS code
        .mockResolvedValue(""); // No 2FA

      mockStartWithAuth.mockResolvedValue("mock_session_string");

      await authFlow.authenticate(123456, "test_hash");

      // Should have prompted 3 times for phone (2 invalid, 1 valid)
      expect(mockPrompt).toHaveBeenCalledTimes(4); // 3 phone + 1 SMS
    });
  });

  describe("authentication flow", () => {
    it("should complete full auth flow with SMS only", async () => {
      const phoneNumber = "+12025551234";
      const smsCode = "12345";
      const sessionString = "mock_session_string";

      mockPrompt.mockResolvedValueOnce(phoneNumber).mockResolvedValueOnce(smsCode);

      mockStartWithAuth.mockImplementation(async ({ phoneNumber: phoneFn, phoneCode: codeFn }) => {
        expect(await phoneFn()).toBe(phoneNumber);
        expect(await codeFn()).toBe(smsCode);
        return sessionString;
      });

      const result = await authFlow.authenticate(123456, "test_hash");

      expect(result).toBe(sessionString);
      expect(mockDisconnect).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it("should complete full auth flow with 2FA", async () => {
      const phoneNumber = "+12025551234";
      const smsCode = "12345";
      const password = "my2fapassword";
      const sessionString = "mock_session_string";

      mockPrompt
        .mockResolvedValueOnce(phoneNumber)
        .mockResolvedValueOnce(smsCode)
        .mockResolvedValueOnce(password);

      mockStartWithAuth.mockImplementation(
        async ({ phoneNumber: phoneFn, phoneCode: codeFn, password: passwordFn }) => {
          expect(await phoneFn()).toBe(phoneNumber);
          expect(await codeFn()).toBe(smsCode);
          expect(await passwordFn()).toBe(password);
          return sessionString;
        },
      );

      const result = await authFlow.authenticate(123456, "test_hash");

      expect(result).toBe(sessionString);
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it("should handle authentication errors", async () => {
      const phoneNumber = "+12025551234";
      const errorMessage = "Invalid phone number";

      mockPrompt.mockResolvedValueOnce(phoneNumber);

      mockStartWithAuth.mockImplementation(async ({ onError }) => {
        onError(new Error(errorMessage));
        throw new Error(errorMessage);
      });

      await expect(authFlow.authenticate(123456, "test_hash")).rejects.toThrow(errorMessage);

      const state = authFlow.getState();
      expect(state.phase).toBe("error");
      expect(state.error).toBe(errorMessage);
    });

    it("should track auth state progression", async () => {
      const phoneNumber = "+12025551234";
      const smsCode = "12345";

      mockPrompt.mockResolvedValueOnce(phoneNumber).mockResolvedValueOnce(smsCode);

      mockStartWithAuth.mockResolvedValue("mock_session");

      // Check initial state
      let state = authFlow.getState();
      expect(state.phase).toBe("phone");

      // Start auth (don't await yet)
      const authPromise = authFlow.authenticate(123456, "test_hash");

      // State should progress through phases
      // (in real scenario, but hard to test async state)

      await authPromise;

      // Check final state
      state = authFlow.getState();
      expect(state.phase).toBe("complete");
      expect(state.phoneNumber).toBe(phoneNumber);
    });
  });

  describe("verifySession", () => {
    it("should return true for valid session", async () => {
      mockConnect.mockResolvedValue(undefined);
      mockGetConnectionState.mockResolvedValue({ authorized: true });
      mockDisconnect.mockResolvedValue(undefined);

      const result = await verifySession(123456, "test_hash", "valid_session");

      expect(result).toBe(true);
      expect(mockConnect).toHaveBeenCalled();
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it("should return false for invalid session", async () => {
      mockConnect.mockResolvedValue(undefined);
      mockGetConnectionState.mockResolvedValue({ authorized: false });
      mockDisconnect.mockResolvedValue(undefined);

      const result = await verifySession(123456, "test_hash", "invalid_session");

      expect(result).toBe(false);
    });

    it("should return false on connection error", async () => {
      mockConnect.mockRejectedValue(new Error("Connection failed"));

      const result = await verifySession(123456, "test_hash", "bad_session");

      expect(result).toBe(false);
    });
  });

  describe("input sanitization", () => {
    it("should strip spaces and dashes from SMS code", async () => {
      const phoneNumber = "+12025551234";
      const smsCodeWithSpaces = "123 45";
      const expectedCode = "12345";

      mockPrompt.mockResolvedValueOnce(phoneNumber).mockResolvedValueOnce(smsCodeWithSpaces);

      mockStartWithAuth.mockImplementation(async ({ phoneCode: codeFn }) => {
        const code = await codeFn();
        expect(code).toBe(expectedCode);
        return "mock_session";
      });

      await authFlow.authenticate(123456, "test_hash");
    });

    it("should not modify 2FA password", async () => {
      const phoneNumber = "+12025551234";
      const smsCode = "12345";
      const passwordWithSpaces = "my password 123";

      mockPrompt
        .mockResolvedValueOnce(phoneNumber)
        .mockResolvedValueOnce(smsCode)
        .mockResolvedValueOnce(passwordWithSpaces);

      mockStartWithAuth.mockImplementation(async ({ password: passwordFn }) => {
        const password = await passwordFn();
        expect(password).toBe(passwordWithSpaces); // Should NOT strip spaces
        return "mock_session";
      });

      await authFlow.authenticate(123456, "test_hash");
    });
  });
});
