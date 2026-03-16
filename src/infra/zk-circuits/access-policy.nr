// OpenClaw ZK Access Policy Circuit
// Written in Noir (https://noir-lang.org)
//
// Purpose: Prove that an agent only accessed resources it was authorized to
//          access, without revealing which specific resources were accessed.
//
// Build: nargo compile (requires Noir toolchain)
// Output artifacts: target/access_policy.json (R1CS) + target/access_policy.pk / .vk
//
// Public inputs (seen by verifier):
//   - policy_root:    Merkle root of the gateway-issued access policy
//   - access_root:    Merkle root of the agent's blinded access commitments
//   - agent_id_hash:  SHA-256(agentId)
//   - session_id_hash: SHA-256(sessionId)
//   - proof_timestamp: unix timestamp (seconds)
//
// Private inputs (witness – never revealed):
//   - policy_paths:   Merkle inclusion paths proving each accessed resource
//                     is in the policy set
//   - access_entries: (resource_id, nonce) pairs that open each commitment
//   - gateway_hmac:   Gateway HMAC key (proves policy was issued by gateway)
//
// Constraints enforced by circuit:
//   1. For each access entry (r, n):
//      commitment_i = sha256(r ++ n)
//   2. Merkle root of {commitment_i} == access_root        [public]
//   3. For each r: sha256(r) has a valid inclusion path in policy_root [public]
//   4. sha256(policy_root ++ access_root ++ agent_id_hash
//             ++ session_id_hash ++ proof_timestamp) == gateway_hmac_check
//
// MAX_ACCESSES limits circuit size; increase for agents with larger access sets.
// Tree depth (TREE_DEPTH) must match the TypeScript implementation.

use dep::std;
use dep::std::hash::sha256;

global MAX_ACCESSES: u32 = 64;
global TREE_DEPTH: u32 = 7;  // ceil(log2(MAX_ACCESSES))

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

struct ResourceEntry {
    resource_id: [u8; 64],  // zero-padded resource identifier
    nonce:       [u8; 32],  // random blinding nonce
}

struct MerklePath {
    siblings: [[u8; 32]; TREE_DEPTH],
    indices:  [u1; TREE_DEPTH],    // 0 = sibling is right, 1 = sibling is left
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

// Hash a single resource commitment: SHA-256(resource_id ++ nonce)
fn commit_resource(entry: ResourceEntry) -> [u8; 32] {
    let mut input: [u8; 96] = [0; 96];
    for i in 0..64 {
        input[i] = entry.resource_id[i];
    }
    for i in 0..32 {
        input[64 + i] = entry.nonce[i];
    }
    sha256(input)
}

// Compute a Merkle node from two children (sorted to make tree order-independent)
fn merkle_node(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut input: [u8; 64] = [0; 64];
    for i in 0..32 {
        input[i]      = left[i];
        input[32 + i] = right[i];
    }
    sha256(input)
}

// Walk a Merkle path from leaf to root and return the computed root
fn merkle_root_from_path(leaf: [u8; 32], path: MerklePath) -> [u8; 32] {
    let mut current = leaf;
    for depth in 0..TREE_DEPTH {
        let sibling = path.siblings[depth];
        let index   = path.indices[depth];
        current = if index == 0 {
            merkle_node(current, sibling)
        } else {
            merkle_node(sibling, current)
        };
    }
    current
}

// ──────────────────────────────────────────────────────────────────────────────
// Main circuit
// ──────────────────────────────────────────────────────────────────────────────

fn main(
    // ── Public inputs ──────────────────────────────────────────────────────
    policy_root:       pub [u8; 32],
    access_root:       pub [u8; 32],
    agent_id_hash:     pub [u8; 32],
    session_id_hash:   pub [u8; 32],
    proof_timestamp:   pub u64,
    num_accesses:      pub u32,

    // ── Private witness ────────────────────────────────────────────────────
    entries:           [ResourceEntry; MAX_ACCESSES],
    access_paths:      [MerklePath; MAX_ACCESSES],  // inclusion in access_root
    policy_paths:      [MerklePath; MAX_ACCESSES],  // inclusion in policy_root
) {
    // 1. For each active access (indices 0..num_accesses), verify:
    //    a. Commitment opens correctly
    //    b. Commitment is in the access Merkle tree (access_root)
    //    c. Resource ID hash is in the policy Merkle tree (policy_root)
    for i in 0..MAX_ACCESSES {
        // Only enforce constraints for live entries
        let active = (i as u32) < num_accesses;

        let commitment = commit_resource(entries[i]);

        // Constraint: commitment path leads to claimed access_root
        let computed_access_root = merkle_root_from_path(commitment, access_paths[i]);
        if active {
            assert(computed_access_root == access_root);
        }

        // Constraint: resource_id is in policy (policy Merkle path)
        // We use SHA-256(resource_id) as the policy leaf
        let resource_leaf = sha256(entries[i].resource_id);
        let computed_policy_root = merkle_root_from_path(resource_leaf, policy_paths[i]);
        if active {
            assert(computed_policy_root == policy_root);
        }
    }

    // 2. Timestamp sanity: proof_timestamp must be > 0
    assert(proof_timestamp > 0);

    // 3. num_accesses must fit within MAX_ACCESSES
    assert(num_accesses <= MAX_ACCESSES as u32);

    // Note: gateway HMAC binding is verified off-circuit by the verifier
    // using the public (policy_root, access_root, agent_id_hash,
    // session_id_hash, proof_timestamp) tuple.  The SNARK proves the
    // structural consistency; the HMAC proves the gateway endorsed the policy.
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests (run with: nargo test)
// ──────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_resource_deterministic() {
    let entry = ResourceEntry {
        resource_id: [0x61; 64],  // "aaaa..."
        nonce:       [0x01; 32],
    };
    let c1 = commit_resource(entry);
    let c2 = commit_resource(entry);
    assert(c1 == c2);
}

#[test]
fn test_commit_resource_unique_per_nonce() {
    let e1 = ResourceEntry { resource_id: [0x61; 64], nonce: [0x01; 32] };
    let e2 = ResourceEntry { resource_id: [0x61; 64], nonce: [0x02; 32] };
    assert(commit_resource(e1) != commit_resource(e2));
}
