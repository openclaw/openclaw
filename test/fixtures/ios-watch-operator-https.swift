import Foundation
import OpenClawKit
import OpenClawProtocol

private enum ProofError: Error {
    case invalidInput
    case persistence
    case unexpectedResult
}

private struct Input: Decodable {
    let endpoint: URL
    let gatewayID: String
    let deviceID: String
    let token: String
}

private struct Failure: Encodable {
    let domain: String
    let code: Int
}

private actor ConnectionObservation {
    private var closed = false

    func didClose() {
        self.closed = true
    }

    func requireOpen() throws {
        guard !self.closed else { throw ProofError.unexpectedResult }
    }
}

@main
private enum OperatorHTTPSProof {
    private static let scopes = ["operator.read", "operator.talk"]

    static func main() async {
        var stage = "input"
        do {
            guard CommandLine.arguments.count == 3,
                  ["identity", "negative", "positive"].contains(CommandLine.arguments[1])
            else { throw ProofError.invalidInput }
            let mode = CommandLine.arguments[1]
            let state = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
            guard DeviceIdentityStore.configureStateDirectory(state),
                  let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary),
                  let publicKey = DeviceIdentityStore.publicKeyBase64Url(identity)
            else { throw ProofError.persistence }
            if mode == "identity" {
                try self.emit([
                    "ok": true,
                    "deviceID": identity.deviceId,
                    "publicKey": publicKey,
                    "platform": InstanceIdentity.platformString,
                    "deviceFamily": InstanceIdentity.deviceFamily,
                ])
                return
            }

            let input = try self.readInput(deviceID: identity.deviceId)
            stage = "persisted-auth"
            if mode == "negative" {
                guard DeviceAuthStore.storeTokenPersisted(
                    deviceId: identity.deviceId,
                    role: "operator",
                    token: input.token,
                    scopes: self.scopes,
                    gatewayID: input.gatewayID,
                    profile: .primary)
                else { throw ProofError.persistence }
            }
            guard let stored = DeviceAuthStore.loadToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: input.gatewayID,
                profile: .primary),
                stored.token.utf8.elementsEqual(input.token.utf8),
                stored.role == "operator", stored.scopes == self.scopes,
                stored.gatewayID?.utf8.elementsEqual(input.gatewayID.utf8) == true
            else { throw ProofError.persistence }

            let session = try GatewayOperatorHTTPSession(endpoint: input.endpoint, gatewayID: input.gatewayID)
            let observation = ConnectionObservation()
            stage = "connect"
            let hello: HelloOk
            do {
                hello = try await session.connect(
                    options: self.connectOptions(gatewayID: input.gatewayID),
                    consumeHello: { hello, isCurrent in
                        guard isCurrent(), hello.auth["deviceToken"] == nil,
                              hello.auth["method"]?.stringValue == "device-token",
                              hello.auth["role"]?.stringValue == "operator",
                              let rawScopes = hello.auth["scopes"]?.arrayValue,
                              rawScopes.count == self.scopes.count,
                              rawScopes.compactMap(\.stringValue) == self.scopes
                        else { throw ProofError.unexpectedResult }
                    },
                    consumeEvent: { _, isCurrent in
                        guard isCurrent() else { throw ProofError.unexpectedResult }
                    },
                    onClosed: { _ in await observation.didClose() })
            } catch {
                await session.disconnect()
                guard mode == "negative", self.isCertificateTrustFailure(error, endpoint: input.endpoint) else {
                    throw error
                }
                guard DeviceAuthStore.loadToken(
                    deviceId: identity.deviceId,
                    role: "operator",
                    gatewayID: input.gatewayID,
                    profile: .primary) == stored
                else { throw ProofError.persistence }
                try self.emit([
                    "ok": true,
                    "stage": "untrusted-certificate-rejected",
                    "persistedAuth": true,
                    "errors": self.failures(error).map { ["domain": $0.domain, "code": $0.code] },
                ])
                return
            }

            do {
                guard mode == "positive",
                      let connectionID = hello.server["connId"]?.stringValue,
                      UUID(uuidString: connectionID) != nil
                else { throw ProofError.unexpectedResult }
                stage = "agents.list"
                _ = try await session.request(
                    method: "agents.list",
                    params: OpenClawProtocol.AnyCodable([String: String]()),
                    timeoutMs: 10000,
                    consume: { response, isCurrent in
                        guard isCurrent(), response.ok, let payload = response.payload else {
                            throw ProofError.unexpectedResult
                        }
                        let result = try JSONDecoder().decode(
                            AgentsListResult.self,
                            from: JSONEncoder().encode(payload))
                        guard result.agents.contains(where: { $0.id == "proof" }) else {
                            throw ProofError.unexpectedResult
                        }
                    })
                stage = "sessions.list"
                _ = try await session.request(
                    method: "sessions.list",
                    params: OpenClawProtocol.AnyCodable(["agentId": "proof", "limit": 5] as [String: Any]),
                    timeoutMs: 10000,
                    consume: { response, isCurrent in
                        guard isCurrent(), response.ok,
                              let payload = response.payload?.dictionaryValue,
                              let sessions = payload["sessions"]?.arrayValue, sessions.isEmpty
                        else { throw ProofError.unexpectedResult }
                    })
                try await observation.requireOpen()
                stage = "disconnect"
                await session.disconnect()
                guard DeviceAuthStore.loadToken(
                    deviceId: identity.deviceId,
                    role: "operator",
                    gatewayID: input.gatewayID,
                    profile: .primary) == stored
                else { throw ProofError.persistence }
                try self.emit([
                    "ok": true,
                    "stage": "connected-read-disconnected",
                    "connectionID": connectionID,
                    "tokenlessHello": true,
                    "unchangedStoredGrant": true,
                    "methods": ["agents.list", "sessions.list"],
                ])
            } catch {
                await session.disconnect()
                throw error
            }
        } catch {
            // Never serialize localized descriptions, userInfo, request bodies, or credentials.
            try? self.emit([
                "ok": false,
                "stage": stage,
                "errors": self.failures(error).map { ["domain": $0.domain, "code": $0.code] },
            ])
            exit(1)
        }
    }

    private static func connectOptions(gatewayID: String) -> GatewayConnectOptions {
        GatewayConnectOptions(
            role: "operator",
            scopes: self.scopes,
            scopesAreExplicit: true,
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-watchos",
            clientMode: "node",
            clientDisplayName: "Hosted Foundation qualification",
            deviceIdentityProfile: .primary,
            deviceAuthGatewayID: gatewayID)
    }

    private static func readInput(deviceID: String) throws -> Input {
        var data = Data()
        while let chunk = try FileHandle.standardInput.read(upToCount: 16385 - data.count),
              !chunk.isEmpty
        {
            data.append(chunk)
            guard data.count <= 16384 else { throw ProofError.invalidInput }
        }
        let input = try JSONDecoder().decode(Input.self, from: data)
        guard input.deviceID.utf8.elementsEqual(deviceID.utf8),
              !input.token.isEmpty, input.endpoint.scheme == "https",
              input.endpoint.host == "localhost",
              input.endpoint.user == nil, input.endpoint.password == nil,
              input.endpoint.query == nil, input.endpoint.fragment == nil
        else { throw ProofError.invalidInput }
        return input
    }

    private static func failures(_ error: any Error) -> [Failure] {
        var result: [Failure] = []
        var current: NSError? = error as NSError
        while let value = current, result.count < 8 {
            let domain = [NSURLErrorDomain, NSOSStatusErrorDomain].contains(value.domain)
                ? value.domain : "other"
            result.append(Failure(domain: domain, code: value.code))
            current = value.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return result
    }

    private static func isCertificateTrustFailure(_ error: any Error, endpoint: URL) -> Bool {
        // A cancelled challenge can hide its cause. Generic cancellation, timeout,
        // and handshake errors are inconclusive and must fail this qualification.
        guard let error = error as? GatewayTLSValidationError else { return false }
        return error.failure.kind == .untrustedCertificate
            && !error.failure.systemTrustOk
            && error.failure.host.utf8.elementsEqual("localhost".utf8)
            && error.failure.port == (endpoint.port ?? 443)
    }

    private static func emit(_ result: [String: Any]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        try FileHandle.standardOutput.write(contentsOf: bytes + Data([0x0A]))
    }
}
