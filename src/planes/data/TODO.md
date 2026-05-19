# DataPlane — 待实现

**优先级**：Phase 1.1（Week 3-5，第一个实现）

## 文件清单

- [ ] `schema.ts` — Drizzle ORM schema（参考 Python Alembic 001-009 迁移）
- [ ] `object-store.ts` — ObjectStore CRUD（SQLite dev / PostgreSQL prod）
- [ ] `ontology-engine.ts` — YAML schema 加载 + 实例验证 + 热重载
- [ ] `kb.ts` — 知识库（Phase 1: 全文检索；Phase 2: 向量检索）
- [ ] `pack-loader.ts` — Pack 加载器（类比 OpenClaw PluginRegistry）
- [ ] `index.ts`

## 参考

- Python ObjectStore：`clawtwin-platform/platform-api/core/object_store/`
- Python Ontology：`clawtwin-platform/platform-api/ontology/`
- Python PackLoader：`clawtwin-platform/platform-api/core/pack_loader/` (900行)
- YAML 直接复用：`clawtwin-platform/platform-api/ontology/object_types/*.yaml`
- 设计文档：`docs/design/MIGRATION-GUIDE.md` § ObjectStore / OntologyEngine
