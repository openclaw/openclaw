import jwt from "jsonwebtoken";
import { logError } from "../logger.js";

export interface JWTPayload {
  userId: string;
  username: string;
  clientId?: string;
  iat?: number;
  exp?: number;
}

const JWT_SECRET = process.env.JWT_SECRET || "development-secret-change-in-production";
const JWT_EXPIRY = process.env.JWT_EXPIRY || "24h";

export function generateToken(payload: Omit<JWTPayload, "iat" | "exp">): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}

const refreshTokens = new Map<string, { expiresAt: number }>();

export function generateRefreshToken(): string {
  const token = require("crypto").randomBytes(32).toString("hex");
  refreshTokens.set(token, { expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  return token;
}

export function verifyRefreshToken(token: string): boolean {
  const record = refreshTokens.get(token);
  if (!record) return false;
  if (Date.now() > record.expiresAt) {
    refreshTokens.delete(token);
    return false;
  }
  return true;
}

export function revokeRefreshToken(token: string): void {
  refreshTokens.delete(token);
}
