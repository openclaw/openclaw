# NeuroLedger: Dezentrale Privacy-Preserving AI Blockchain

## Executive Summary
NeuroLedger ist ein dezentrales Protokoll, das die Spannung zwischen KI-Datenbedarf und Privatsphäre löst. Es nutzt ein Netzwerk aus autonomen Minern ("NeuroNodes"), die in Trusted Execution Environments (TEEs) operieren, um hochdimensionale Vektor-Embeddings zu generieren, ohne jemals Zugriff auf den Klartext der Nutzerdaten zu haben ("Blind Inference").

## Technische Architektur

### 1. Agent-to-Agent (A2A) & n:m Vernetzung
- **Kommunikation**: Basiert auf `libp2p` mit Noise-Protokoll für verschlüsselte Tunnel.
- **Discovery**: Erweiterte Kademlia DHT, die nicht nur Peers, sondern spezifische Service-Capabilities (z.B. "H100 GPU + Llama-3") indiziert.
- **Messaging**: GossipSub v1.1 für die Verbreitung von Zustandsänderungen im n:m Mesh.

### 2. Privacy-Preserving Computation
- **Compute Layer**: Nutzung von TEEs (Intel SGX, AMD SEV-SNP, NVIDIA Confidential Computing) für die Inferenz.
- **Verschlüsselung**: Hybrid-Ansatz. Daten werden vom Nutzer mit Session-Keys verschlüsselt, die nur innerhalb des TEEs entschlüsselt werden können via Remote Attestation.
- **Vektorsuche**: Federated Encrypted DiskANN. Vektor-Indizes liegen verschlüsselt auf SSDs und werden nur "Just-in-Time" innerhalb des Enclaves für Suchoperationen entschlüsselt.

### 3. Konsens: Proof of Inference (PoI)
- **Mechanismus**: Ein kryptografischer Beweis, dass eine spezifische Berechnung (Inferenz) tatsächlich auf den angegebenen Daten mit dem angegebenen Modell in einem verifizierten TEE durchgeführt wurde.
- **Tier 1**: TEE-Signatur (schnell).
- **Tier 2**: Probabilistische Auditierung durch Replikation und Slashing bei Abweichungen.

### 4. Federated RAG (FRAG)
Ermöglicht Retrieval-Augmented Generation über verteilte, private Datenbestände hinweg, ohne dass Daten zentralisiert werden müssen.
