import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface PluginSignature {
  algorithm: "RSA-SHA256" | "Ed25519";
  signature: string;
  publicKey: string;
  timestamp: number;
  version: string;
}

export interface SignatureVerificationResult {
  valid: boolean;
  error?: string;
  signature?: PluginSignature;
}

export class PluginSigner {
  /**
   * Verify plugin signature before loading
   * @param pluginPath Path to the plugin file
   * @param signature Plugin signature object
   * @param trustedPublicKeys Array of trusted public keys in PEM format
   * @returns true if signature is valid, throws error otherwise
   */
  static verifySignature(
    pluginPath: string,
    signature: PluginSignature,
    trustedPublicKeys: string[],
  ): boolean {
    // Read plugin code
    if (!fs.existsSync(pluginPath)) {
      throw new Error(`Plugin file not found: ${pluginPath}`);
    }

    const pluginCode = fs.readFileSync(pluginPath);

    // Verify public key is trusted
    if (!trustedPublicKeys.includes(signature.publicKey)) {
      throw new Error("Untrusted public key");
    }

    // Verify signature based on algorithm
    try {
      const verify = crypto.createVerify(signature.algorithm);
      verify.update(pluginCode);
      verify.update(signature.version);
      verify.update(signature.timestamp.toString());

      const isValid = verify.verify(signature.publicKey, signature.signature, "base64");

      if (!isValid) {
        throw new Error("Invalid signature");
      }

      return true;
    } catch (err) {
      throw new Error(`Signature verification failed: ${String(err)}`, { cause: err });
    }
  }

  /**
   * Sign a plugin (for developers/CI)
   * @param pluginPath Path to the plugin file
   * @param privateKey Private key in PEM format
   * @param version Plugin version string
   * @returns PluginSignature object
   */
  static signPlugin(pluginPath: string, privateKey: string, version: string): PluginSignature {
    if (!fs.existsSync(pluginPath)) {
      throw new Error(`Plugin file not found: ${pluginPath}`);
    }

    const pluginCode = fs.readFileSync(pluginPath);
    const timestamp = Date.now();

    try {
      const sign = crypto.createSign("RSA-SHA256");
      sign.update(pluginCode);
      sign.update(version);
      sign.update(timestamp.toString());

      const signature = sign.sign(privateKey, "base64");

      // Extract public key from private key
      const publicKeyObj = crypto.createPublicKey(privateKey);
      const publicKey = publicKeyObj
        .export({
          type: "spki",
          format: "pem",
        })
        .toString();

      return {
        algorithm: "RSA-SHA256",
        signature,
        publicKey,
        timestamp,
        version,
      };
    } catch (err) {
      throw new Error(`Failed to sign plugin: ${String(err)}`, { cause: err });
    }
  }

  /**
   * Load and verify signature from plugin directory
   * @param pluginDir Directory containing the plugin
   * @param pluginFile Name of the plugin file
   * @param trustedPublicKeys Array of trusted public keys
   * @returns SignatureVerificationResult
   */
  static verifyPluginDirectory(
    pluginDir: string,
    pluginFile: string,
    trustedPublicKeys: string[],
  ): SignatureVerificationResult {
    const pluginPath = path.join(pluginDir, pluginFile);
    const signaturePath = path.join(pluginDir, "plugin.signature.json");

    // Check if signature file exists
    if (!fs.existsSync(signaturePath)) {
      return {
        valid: false,
        error: "No signature found",
      };
    }

    try {
      // Load signature
      const signatureData = fs.readFileSync(signaturePath, "utf8");
      const signature = JSON.parse(signatureData) as PluginSignature;

      // Verify signature
      this.verifySignature(pluginPath, signature, trustedPublicKeys);

      return {
        valid: true,
        signature,
      };
    } catch (err) {
      return {
        valid: false,
        error: String(err),
      };
    }
  }

  /**
   * Check if plugin has been tampered with since signing
   * @param pluginPath Path to the plugin file
   * @param signaturePath Path to the signature file
   * @returns true if plugin matches signature
   */
  static checkIntegrity(pluginPath: string, signaturePath: string): boolean {
    if (!fs.existsSync(pluginPath) || !fs.existsSync(signaturePath)) {
      return false;
    }

    try {
      const signatureData = fs.readFileSync(signaturePath, "utf8");
      const signature = JSON.parse(signatureData) as PluginSignature;
      const pluginCode = fs.readFileSync(pluginPath);

      // Recreate the hash that was signed
      const verify = crypto.createVerify(signature.algorithm);
      verify.update(pluginCode);
      verify.update(signature.version);
      verify.update(signature.timestamp.toString());

      return verify.verify(signature.publicKey, signature.signature, "base64");
    } catch {
      return false;
    }
  }

  /**
   * Get plugin signature metadata without verification
   * @param pluginDir Directory containing the plugin
   * @returns PluginSignature or null if not found
   */
  static getSignatureMetadata(pluginDir: string): PluginSignature | null {
    const signaturePath = path.join(pluginDir, "plugin.signature.json");

    if (!fs.existsSync(signaturePath)) {
      return null;
    }

    try {
      const signatureData = fs.readFileSync(signaturePath, "utf8");
      return JSON.parse(signatureData) as PluginSignature;
    } catch {
      return null;
    }
  }
}
