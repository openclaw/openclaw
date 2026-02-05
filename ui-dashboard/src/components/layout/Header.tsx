import { NavLink } from 'react-router-dom';
import styles from './Header.module.css';

const tabs = [
  { path: '/', label: 'Chat' },
  { path: '/board', label: 'Board' },
  { path: '/git', label: 'Git' },
  { path: '/files', label: 'Files' },
  { path: '/timeline', label: 'Timeline' },
  { path: '/settings', label: 'Settings' },
];

export function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.logo}>
        <span className={styles.logoIcon}>OC</span>
        <span>OpenClaw</span>
      </div>

      <div className={styles.divider} />

      <div className={styles.projectSelector}>
        <span>myapp</span>
        <span className={styles.chevron}>&#x25BC;</span>
      </div>

      <nav className={styles.tabs}>
        {tabs.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            className={({ isActive }) =>
              `${styles.tab} ${isActive ? styles.active : ''}`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <div className={styles.spacer} />

      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statValue}>$2.41</span>
          <span className={styles.statLabel}>today</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>124k</span>
          <span className={styles.statLabel}>tokens</span>
        </div>
      </div>
    </header>
  );
}
