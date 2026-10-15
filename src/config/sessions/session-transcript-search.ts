// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and schedules the shared reconcile owner
// when doctor imports or out-of-band writes leave derived rows behind.
import { sql } from "kysely";
import { admitStoreSearch } from "../../infra/database-engine/adapters.js";
import { requireDatabaseSearchCapability } from "../../infra/database-engine/search-capabilities.js";
